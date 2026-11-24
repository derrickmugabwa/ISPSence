import { lockCustomer, scheduleAllows, type AccessSchedule } from './accessPolicy';
import { startAccessManagementSweep } from './accessReconciliation';
import { query, transaction } from '../../config/database';
import { closeExpiredSessions } from './sessions';

export const SUBSCRIPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id UUID PRIMARY KEY,
  purchase_id UUID NOT NULL REFERENCES billing_purchases(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('live','simulation')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_payment','pending_activation','active','expired')),
  activation_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (purchase_id,mode),
  CHECK (mode='simulation' OR status IN ('awaiting_payment','pending_activation')),
  CHECK ((activation_at IS NULL AND expires_at IS NULL AND status IN ('awaiting_payment','pending_activation'))
    OR (activation_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>activation_at AND status IN ('active','expired')))
);
CREATE TABLE IF NOT EXISTS billing_access_accounts (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL UNIQUE REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  username VARCHAR(64) NOT NULL UNIQUE,
  router_id INTEGER REFERENCES devices(id) ON DELETE RESTRICT,
  hotspot_name VARCHAR(100),
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','simulated_ready','simulated_expired')),
  device_limit INTEGER NOT NULL DEFAULT 1 CHECK (device_limit=1),
  credentials_issued BOOLEAN NOT NULL DEFAULT false CHECK (credentials_issued=false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((router_id IS NULL AND hotspot_name IS NULL) OR (router_id IS NOT NULL AND hotspot_name IS NOT NULL AND length(trim(hotspot_name))>0))
);
CREATE TABLE IF NOT EXISTS billing_access_events (
  id BIGSERIAL PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('prepared','simulation_activated','simulation_expired')),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,kind)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_due_idx ON billing_subscriptions(expires_at)
  WHERE mode='simulation' AND status='active';
CREATE OR REPLACE FUNCTION preserve_billing_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.purchase_id,NEW.mode,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.purchase_id,OLD.mode,OLD.created_at)
    OR (OLD.activation_at IS NOT NULL AND ROW(NEW.activation_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.activation_at,OLD.expires_at)) THEN
    RAISE EXCEPTION 'Subscription identity and confirmed timestamps are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_activation' AND tgrelid='billing_subscriptions'::regclass) THEN
    CREATE TRIGGER immutable_billing_activation BEFORE UPDATE ON billing_subscriptions FOR EACH ROW EXECUTE FUNCTION preserve_billing_activation();
  END IF;
END $$;
`;

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export { SIMULATION_TIMES } from './accessTime';

export async function expireSimulations(): Promise<number> {
  const candidates = await query<{ customer_id: number }>(`SELECT DISTINCT coalesce(p.customer_id,g.customer_id) AS customer_id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE s.mode='simulation' AND s.status='active' ORDER BY customer_id`);
  let total = 0;
  for (const { customer_id: customerId } of candidates) total += await transaction(async (client) => {
    // Take the customer lock first, then read runtime in a fresh statement. A pause
    // committed while expiry was waiting must be visible before selecting due rows.
    await lockCustomer(client,customerId);
    const due = await client.query(`UPDATE billing_subscriptions SET status='expired',revision=revision+1
      WHERE mode='simulation' AND status='active' AND coalesce((SELECT r.effective_expires_at FROM billing_subscription_runtime r WHERE r.subscription_id=billing_subscriptions.id),expires_at)<=clock_timestamp() AND id IN (SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=$1) AND NOT EXISTS (SELECT 1 FROM billing_subscription_runtime r WHERE r.subscription_id=billing_subscriptions.id AND (r.frozen_remaining_ms IS NOT NULL OR r.revoked_at IS NOT NULL)) RETURNING id`,[customerId]);
    if (due.rows.length) await client.query(`UPDATE billing_access_accounts SET state='simulated_expired'
      WHERE subscription_id=ANY($1::uuid[])`, [due.rows.map((r: { id: string }) => r.id)]);
    if (due.rows.length) await client.query(`INSERT INTO billing_access_events(subscription_id,kind,actor)
      SELECT unnest($1::uuid[]),'simulation_expired','system:simulation-expiry' ON CONFLICT DO NOTHING`, [due.rows.map((r: { id: string }) => r.id)]);
    if (due.rows.length) await closeExpiredSessions(client,due.rows.map((r: { id: string }) => r.id));
    return due.rows.length;
  });
  return total;
}

// Query text is exported for read-only execution-plan regression checks.
export const SUBSCRIPTION_LIST_SQL = `SELECT pol.schedule AS access_schedule,s.*,s.expires_at AS original_expires_at,CASE WHEN r.frozen_remaining_ms IS NULL THEN coalesce(r.effective_expires_at,s.expires_at) END AS expires_at,
    r.frozen_remaining_ms::float8,r.revoked_at,coalesce(ctl.desired_state,'enabled') AS desired_access_state,coalesce(r.applied_state,CASE WHEN s.mode='simulation' AND s.status='active' THEN 'enabled' ELSE 'unknown' END) AS applied_access_state,
    CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' WHEN r.frozen_remaining_ms IS NOT NULL THEN 'paused' WHEN s.status='expired' THEN 'expired' WHEN EXISTS (SELECT 1 FROM billing_renewals q WHERE q.successor_id=s.id AND q.status IN ('queued','pending_live')) THEN 'queued_renewal' WHEN coalesce(ctl.desired_state,'enabled')<>'enabled' THEN ctl.desired_state ELSE s.status END AS access_state,coalesce(p.reference,g.reference) AS payment_reference,p.payment_status,
    coalesce(p.package_snapshot,g.package_snapshot) AS package_snapshot,
    CASE WHEN g.id IS NOT NULL THEN 'complimentary' ELSE 'purchase' END AS funding,
    g.reason AS grant_reason,g.actor AS granted_by,
    coalesce(p.customer_id,g.customer_id) AS customer_id,c.full_name AS customer_name,c.customer_code,a.id AS account_id,coalesce(cs.username,a.username) AS username,a.router_id,a.hotspot_name,
    coalesce(p.service_id,g.service_id) AS service_id,coalesce(cs.service_type,'hotspot') AS service_type,cs.label AS service_label,
    coalesce(pol.max_sessions,1) AS desired_session_limit,a.state AS account_state,CASE WHEN cs.service_type='pppoe' THEN EXISTS(SELECT 1 FROM billing_service_credentials sc WHERE sc.service_id=cs.id) ELSE a.credentials_issued END AS credentials_issued,a.device_limit,
    coalesce(n.download_bps,(coalesce(p.package_snapshot,g.package_snapshot)->>'download_bps')::bigint)::float8 AS desired_download_bps,
    coalesce(n.upload_bps,(coalesce(p.package_snapshot,g.package_snapshot)->>'upload_bps')::bigint)::float8 AS desired_upload_bps,
    (n.download_bps IS NOT NULL) AS speed_override,'not_applied'::text AS speed_enforcement
    FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id
    LEFT JOIN billing_access_grants g ON g.id=s.grant_id
    LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    LEFT JOIN billing_customer_controls ctl ON ctl.customer_id=coalesce(p.customer_id,g.customer_id)
    JOIN billing_customers c ON c.id=coalesce(p.customer_id,g.customer_id)
    LEFT JOIN billing_customer_network n ON n.customer_id=c.id
    LEFT JOIN billing_access_policy pol ON pol.customer_id=c.id
    LEFT JOIN billing_customer_services cs ON cs.id=coalesce(p.service_id,g.service_id)
    JOIN billing_access_accounts a ON a.subscription_id=s.id
    WHERE ($1::int IS NULL OR c.id=$1) ORDER BY s.created_at DESC,s.id`;

export async function subscriptionList(customerId?: number): Promise<Array<Record<string,unknown> & {access_state:string}>> {
  const rows = await transaction(async client => {
    // Keep report compilation from dominating this short index/lookup query.
    // LOCAL restores the setting when the transaction ends, including on errors.
    await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET LOCAL jit = off');
    return (await client.query<Record<string,unknown> & { access_schedule: AccessSchedule | null; access_state: string }>(SUBSCRIPTION_LIST_SQL,[customerId ?? null])).rows;
  });
  const now = new Date();
  return rows.map(({ access_schedule,...row }) => ({ ...row,access_state: row.access_state === 'active' && !scheduleAllows(access_schedule,now) ? 'outside_schedule' : row.access_state }));
}

export function startSimulationExpiry(): void { startAccessManagementSweep(expireSimulations); }
