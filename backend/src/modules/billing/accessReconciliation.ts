import { query, transaction } from '../../config/database';
import { AccessError, lockCustomer, scheduleAllows, checkReadiness, SUBSCRIPTION_CUSTOMER_JOIN } from './accessPolicy';
import { applySimulationControl, closeCustomerSessions, managementEvent } from './accessManagement';
import { SIMULATION_TIMES } from './accessTime';

export async function reconcileAccessManagement(): Promise<void> {
  const customers = await query<{ customer_id: number }>(`SELECT customer_id FROM billing_customer_controls UNION SELECT customer_id FROM billing_access_policy WHERE (schedule->>'enabled')::boolean`);
  for (const { customer_id: id } of customers) await transaction(async (client) => {
    await lockCustomer(client,id);
    let control = (await client.query('SELECT * FROM billing_customer_controls WHERE customer_id=$1',[id])).rows[0];
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    if (control?.desired_state === 'vacation' && control.resume_at && new Date(control.resume_at)<=now) {
      control = (await client.query(`UPDATE billing_customer_controls SET desired_state='enabled',resume_at=NULL,version=version+1,
        actor='system:vacation-return',reason='Scheduled vacation return',updated_at=$2 WHERE customer_id=$1 RETURNING *`,[id,now])).rows[0];
      await managementEvent(client,id,'vacation_return_requested',control.actor,control.reason,{ version: control.version });
    }
    const schedule = (await client.query('SELECT schedule FROM billing_access_policy WHERE customer_id=$1',[id])).rows[0]?.schedule;
    const allowed = scheduleAllows(schedule,now), desired = control?.desired_state ?? 'enabled';
    const subs = (await client.query(`SELECT s.id,s.mode,s.status,s.expires_at,r.applied_state,r.frozen_remaining_ms,r.revoked_at,r.effective_expires_at
      FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
      WHERE coalesce(p.customer_id,g.customer_id)=$1 ORDER BY s.id FOR UPDATE OF s`,[id])).rows;
    for (const sub of subs) {
      if (sub.revoked_at) continue;
      if (control && (sub.applied_state !== desired || (sub.frozen_remaining_ms !== null && sub.frozen_remaining_ms !== undefined && desired !== 'vacation' && allowed))) {
        await applySimulationControl(client,id,sub,desired,control.actor,control.reason,control.version,allowed);
      }
    }
    if (!allowed && desired === 'enabled') {
      const closed = await closeCustomerSessions(client,id,'schedule_closed','system:schedule');
      if (closed) await managementEvent(client,id,'schedule_enforced','system:schedule','Outside scheduled access hours',{ closed_simulations: closed });
    }
  });
}

export async function reconcileRenewals(): Promise<void> {
  const pending = await query<{ customer_id: number; predecessor_id: string; successor_id: string }>(`SELECT r.customer_id,r.predecessor_id,r.successor_id FROM billing_renewals r
    JOIN billing_subscriptions s ON s.id=r.predecessor_id WHERE r.status='queued' AND s.status='expired' ORDER BY r.created_at`);
  for (const renewal of pending) await transaction(async (client) => {
    await lockCustomer(client,renewal.customer_id);
    const rows = (await client.query(`SELECT s.*,coalesce(p.package_snapshot,g.package_snapshot) AS terms,p.payment_status FROM billing_subscriptions s
      ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE s.id=ANY($1::uuid[]) ORDER BY s.id FOR UPDATE OF s`,[[renewal.predecessor_id,renewal.successor_id]])).rows;
    const before = rows.find((r) => r.id === renewal.predecessor_id), after = rows.find((r) => r.id === renewal.successor_id);
    const current = (await client.query('SELECT status FROM billing_renewals WHERE predecessor_id=$1',[renewal.predecessor_id])).rows[0];
    if (!before || !after || before.status !== 'expired' || after.activation_at || current?.status !== 'queued') return;
    try { await checkReadiness(client,after.id,new Date(),true); } catch (e) { if (e instanceof AccessError) return; throw e; }
    if (after.mode !== 'simulation') {
      await client.query("UPDATE billing_renewals SET status='pending_live' WHERE predecessor_id=$1",[before.id]);
      return; // No live router adapter or fabricated funding confirmation.
    }
    const t = after.terms;
    if (!Number.isInteger(t.duration_value) || t.duration_value<1 || t.duration_value>10000 || !['hour','day','week','calendar_month'].includes(t.duration_unit)) throw new Error('Renewal has invalid preserved duration');
    const times = (await client.query(SIMULATION_TIMES,[t.duration_unit,t.duration_value,t.timezone || 'UTC'])).rows[0];
    await client.query("UPDATE billing_subscriptions SET status='active',activation_at=$2,expires_at=$3,revision=revision+1 WHERE id=$1",[after.id,times.activation_at,times.expires_at]);
    await client.query("UPDATE billing_access_accounts SET state='simulated_ready' WHERE subscription_id=$1",[after.id]);
    await client.query("INSERT INTO billing_access_events(subscription_id,kind,actor) VALUES($1,'simulation_activated','system:renewal') ON CONFLICT DO NOTHING",[after.id]);
    await client.query("UPDATE billing_renewals SET status='applied_simulation' WHERE predecessor_id=$1",[before.id]);
    await client.query("UPDATE billing_access_jobs SET status='applied_simulation',updated_at=clock_timestamp() WHERE kind IN ('prepare','renewal') AND scope_key=$1 AND status='pending'",[after.id]);
    await managementEvent(client,renewal.customer_id,'renewal_effective_simulation','system:renewal','Predecessor expired and test access is ready',{ predecessor_id: before.id,successor_id: after.id,activation_at: times.activation_at,expires_at: times.expires_at });
  });
}

export async function generateAccessAlerts(): Promise<void> {
  // Resolve superseded deadlines and completed renewals without deleting history.
  await query(`UPDATE billing_access_alerts a SET resolved_at=clock_timestamp() WHERE a.resolved_at IS NULL AND (
    (a.kind='expiry_soon' AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
      WHERE s.id=a.subscription_id AND s.status='active' AND r.revoked_at IS NULL AND r.frozen_remaining_ms IS NULL
      AND coalesce(r.effective_expires_at,s.expires_at)=a.deadline AND a.deadline>clock_timestamp()))
    OR (a.kind='expired' AND (EXISTS (SELECT 1 FROM billing_renewals q WHERE q.predecessor_id=a.subscription_id AND q.status='applied_simulation')
      OR EXISTS (SELECT 1 FROM billing_subscription_runtime r WHERE r.subscription_id=a.subscription_id AND r.revoked_at IS NOT NULL)))
    OR (a.kind='provisioning_failed' AND NOT EXISTS(SELECT 1 FROM billing_access_jobs j WHERE 'job:'||j.id::text=a.dedupe_key AND j.status='failed'))) `);
  await query(`INSERT INTO billing_access_alerts(id,customer_id,subscription_id,kind,message,dedupe_key,deadline)
    SELECT gen_random_uuid(),coalesce(p.customer_id,g.customer_id),s.id,'expiry_soon','Access expires within 24 hours',
      'soon:'||s.id::text||':'||coalesce(r.effective_expires_at,s.expires_at)::text,coalesce(r.effective_expires_at,s.expires_at)
    FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    WHERE s.status='active' AND r.revoked_at IS NULL AND r.frozen_remaining_ms IS NULL
      AND coalesce(r.effective_expires_at,s.expires_at)>clock_timestamp() AND coalesce(r.effective_expires_at,s.expires_at)<=clock_timestamp()+interval '24 hours'
    ON CONFLICT(dedupe_key) DO NOTHING`);
  await query(`INSERT INTO billing_access_alerts(id,customer_id,subscription_id,kind,message,dedupe_key,deadline)
    SELECT gen_random_uuid(),coalesce(p.customer_id,g.customer_id),s.id,'expired','Access period expired','expired:'||s.id::text,coalesce(r.effective_expires_at,s.expires_at)
    FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    WHERE s.status='expired' AND r.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM billing_renewals q WHERE q.predecessor_id=s.id AND q.status='applied_simulation')
    ON CONFLICT(dedupe_key) DO NOTHING`);
  await query(`INSERT INTO billing_access_alerts(id,customer_id,subscription_id,kind,message,dedupe_key)
    SELECT gen_random_uuid(),customer_id,subscription_id,'provisioning_failed','Access change failed: '||kind,'job:'||id::text
    FROM billing_access_jobs WHERE status='failed' ON CONFLICT(dedupe_key) DO NOTHING`);
}

// Single-flight to avoid overlapping sweeps when a database is slow.
export function startAccessManagementSweep(expire: () => Promise<unknown>): void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try { await reconcileAccessManagement(); await expire(); await reconcileRenewals(); await generateAccessAlerts(); }
    catch (e) { console.error('[billing access reconciliation]',(e as Error).message); }
    finally { running = false; }
  };
  void sweep();
  const timer = setInterval(() => { void sweep(); },15000); timer.unref();
}
