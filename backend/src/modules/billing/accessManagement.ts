import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../config/database';
import { AccessError, validUuid, textReason, macAddress, versionNumber, parseSchedule, scheduleAllows, lockCustomer, SUBSCRIPTION_CUSTOMER_JOIN } from './accessPolicy';

export async function enqueueAccessJob(client: PoolClient, customerId: number, kind: string, scope: string, version: number,
  desired: unknown, actor: string, reason: string, status = 'pending', subscriptionId: string | null = null) {
  await client.query(`UPDATE billing_access_jobs SET status='superseded',updated_at=clock_timestamp()
    WHERE kind=$1 AND scope_key=$2 AND version<$3 AND status IN ('pending','failed')`,[kind,scope,version]);
  await client.query(`INSERT INTO billing_access_jobs(id,customer_id,subscription_id,kind,scope_key,version,desired,status,actor,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(kind,scope_key,version) DO UPDATE
    SET status=CASE WHEN billing_access_jobs.status='pending' AND EXCLUDED.status='applied_simulation' THEN EXCLUDED.status ELSE billing_access_jobs.status END,
    updated_at=CASE WHEN billing_access_jobs.status='pending' AND EXCLUDED.status='applied_simulation' THEN clock_timestamp() ELSE billing_access_jobs.updated_at END`,
  [randomUUID(),customerId,subscriptionId,kind,scope,version,JSON.stringify(desired),status,actor,reason]);
}
export async function managementEvent(client: PoolClient, customerId: number, kind: string, actor: string, reason: string, payload: unknown) {
  await client.query('INSERT INTO billing_management_events(customer_id,kind,actor,reason,payload) VALUES($1,$2,$3,$4,$5)',[customerId,kind,actor,reason,JSON.stringify(payload)]);
}
export async function managementOperation(customerId: number, kind: string, body: unknown, fields: string[], actor: string,
  execute: (client: PoolClient, b: Record<string,unknown>, reason: string) => Promise<Record<string,unknown>>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400,'Operation details are required');
  const b = body as Record<string,unknown>;
  if (!validUuid(b.request_key) || Object.keys(b).some((k) => !['request_key','reason',...fields].includes(k))) throw new AccessError(400,'A valid request key and supported fields are required');
  const reason = textReason(b.reason), key = b.request_key.toLowerCase(), payload = JSON.stringify({ customer_id: customerId,kind,...b,request_key: key });
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[key]);
    const prior = (await client.query('SELECT result,payload=$2::jsonb AS matches FROM billing_management_requests WHERE request_key=$1',[key,payload])).rows[0];
    if (prior) { if (!prior.matches) throw new AccessError(409,'Request key already used for different details'); return { ...prior.result,replayed: true }; }
    await lockCustomer(client,customerId);
    const result = await execute(client,b,reason);
    await managementEvent(client,customerId,kind,actor,reason,{ ...b,result });
    await client.query('INSERT INTO billing_management_requests(request_key,payload,result) VALUES($1,$2,$3)',[key,payload,JSON.stringify(result)]);
    return { ...result,replayed: false };
  });
}

export async function closeCustomerSessions(client: PoolClient, customerId: number, reason: string, actor: string,
  filters: { subscription?: string; mac?: string; session?: string } = {}) {
  const result = await client.query(`WITH targets AS (
    SELECT x.id,greatest(x.started_at,least(clock_timestamp(),coalesce(r.effective_expires_at,s.expires_at))) AS boundary,
      CASE WHEN coalesce(r.effective_expires_at,s.expires_at)<=clock_timestamp() THEN 'subscription_expired' ELSE $2::text END AS reason
    FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id JOIN billing_subscriptions s ON s.id=a.subscription_id
    ${SUBSCRIPTION_CUSTOMER_JOIN} LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    WHERE coalesce(p.customer_id,g.customer_id)=$1 AND x.ended_at IS NULL AND x.source='simulation'
      AND ($3::uuid IS NULL OR s.id=$3) AND ($4::macaddr IS NULL OR x.client_mac=$4) AND ($5::uuid IS NULL OR x.id=$5)
  ), closed AS (
    UPDATE billing_sessions x SET ended_at=t.boundary,end_reason=t.reason,updated_at=clock_timestamp() FROM targets t
    WHERE x.id=t.id AND x.ended_at IS NULL RETURNING x.*
  ) INSERT INTO billing_session_events(request_key,session_id,kind,payload,download_bytes,upload_bytes,reason,actor)
    SELECT gen_random_uuid(),id,'stop','{"system":"access_management"}'::jsonb,download_bytes,upload_bytes,end_reason,$6 FROM closed RETURNING session_id`,
  [customerId,reason,filters.subscription ?? null,filters.mac ?? null,filters.session ?? null,actor]);
  return result.rows.length;
}

export async function addCustomerDevice(client: PoolClient, customerId: number, label: string, mac: string, actor: string) {
  const prior = (await client.query('SELECT * FROM billing_customer_devices WHERE customer_id=$1 AND mac=$2::macaddr',[customerId,mac])).rows[0];
  if (prior) { if (prior.label !== label || !prior.enabled) throw new AccessError(409,'Device already exists; edit or re-enable its existing record'); return prior; }
  const count = (await client.query('SELECT count(*)::int AS n FROM billing_customer_devices WHERE customer_id=$1 AND enabled',[customerId])).rows[0].n;
  const limit = (await client.query('SELECT max_devices FROM billing_access_policy WHERE customer_id=$1',[customerId])).rows[0]?.max_devices ?? 5;
  if (count>=limit) throw new AccessError(409,'Registered-device limit reached');
  const device = (await client.query('INSERT INTO billing_customer_devices(id,customer_id,label,mac) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),customerId,label,mac])).rows[0];
  await enqueueAccessJob(client,customerId,'device',device.id,1,{ enabled: true,mac,label },actor,'Device registered');
  return device;
}
export async function registerDevice(customerId: number, body: unknown, actor: string) {
  return managementOperation(customerId,'device_registered',body,['label','mac'],actor,async (client,b) => {
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length>100) throw new AccessError(400,'Enter a device label up to 100 characters');
    const device = await addCustomerDevice(client,customerId,b.label.trim(),macAddress(b.mac),actor);
    return { device };
  });
}
export async function changeDevice(customerId: number, deviceId: string, body: unknown, actor: string) {
  if (!validUuid(deviceId)) throw new AccessError(400,'Invalid device ID');
  return managementOperation(customerId,`device_changed:${deviceId}`,body,['version','enabled','label'],actor,async (client,b,reason) => {
    const version = versionNumber(b.version);
    if (typeof b.enabled !== 'boolean' || typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length>100) throw new AccessError(400,'Choose a device label and enabled state');
    const device = (await client.query('SELECT * FROM billing_customer_devices WHERE id=$1 AND customer_id=$2 FOR UPDATE',[deviceId,customerId])).rows[0];
    if (!device) throw new AccessError(404,'Device not found');
    if (device.version !== version) throw new AccessError(409,'Device changed. Refresh before saving.');
    if (b.enabled && !device.enabled) {
      const n = (await client.query('SELECT count(*)::int AS n FROM billing_customer_devices WHERE customer_id=$1 AND enabled',[customerId])).rows[0].n;
      const max = (await client.query('SELECT max_devices FROM billing_access_policy WHERE customer_id=$1',[customerId])).rows[0]?.max_devices ?? 5;
      if (n>=max) throw new AccessError(409,'Registered-device limit reached');
    }
    if (!b.enabled) await closeCustomerSessions(client,customerId,'device_disabled',actor,{ mac: device.mac });
    const saved = (await client.query('UPDATE billing_customer_devices SET label=$1,enabled=$2,version=version+1 WHERE id=$3 RETURNING *',[b.label.trim(),b.enabled,deviceId])).rows[0];
    await enqueueAccessJob(client,customerId,'device',deviceId,saved.version,{ enabled: saved.enabled,mac: saved.mac,label: saved.label },actor,reason);
    return { device: saved };
  });
}
export async function saveAccessPolicy(customerId: number, body: unknown, actor: string) {
  return managementOperation(customerId,'policy_changed',body,['version','max_devices','max_sessions','registered_only','schedule'],actor,async (client,b,reason) => {
    const version = versionNumber(b.version), schedule = parseSchedule(b.schedule);
    if (!Number.isInteger(b.max_devices) || (b.max_devices as number)<1 || (b.max_devices as number)>50 || !Number.isInteger(b.max_sessions) || (b.max_sessions as number)<1 || (b.max_sessions as number)>20 || typeof b.registered_only !== 'boolean') throw new AccessError(400,'Choose 1–50 registered devices and 1–20 simultaneous sessions');
    const previous = (await client.query('SELECT version FROM billing_access_policy WHERE customer_id=$1',[customerId])).rows[0]?.version ?? 0;
    if (version !== previous) throw new AccessError(409,'Access policy changed. Refresh before saving.');
    const count = (await client.query('SELECT count(*)::int AS n FROM billing_customer_devices WHERE customer_id=$1 AND enabled',[customerId])).rows[0].n;
    const active = (await client.query(`SELECT x.client_mac FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id
      JOIN billing_subscriptions s ON s.id=a.subscription_id ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE coalesce(p.customer_id,g.customer_id)=$1 AND x.ended_at IS NULL`,[customerId])).rows;
    if (count>(b.max_devices as number) || active.length>(b.max_sessions as number)) throw new AccessError(409,'Disable extra devices or disconnect sessions before lowering these limits');
    if (b.registered_only) {
      const registered = (await client.query('SELECT mac::text FROM billing_customer_devices WHERE customer_id=$1 AND enabled',[customerId])).rows.map((r) => r.mac);
      if (active.some((s) => !registered.includes(s.client_mac))) throw new AccessError(409,'Register or disconnect active devices before enabling registered-only access');
    }
    const policy = (await client.query(`INSERT INTO billing_access_policy(customer_id,max_devices,max_sessions,registered_only,schedule,version)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id) DO UPDATE SET max_devices=EXCLUDED.max_devices,max_sessions=EXCLUDED.max_sessions,
      registered_only=EXCLUDED.registered_only,schedule=EXCLUDED.schedule,version=EXCLUDED.version,updated_at=clock_timestamp() RETURNING *`,
    [customerId,b.max_devices,b.max_sessions,b.registered_only,JSON.stringify(schedule),version+1])).rows[0];
    if (!scheduleAllows(schedule)) await closeCustomerSessions(client,customerId,'schedule_closed',actor);
    await enqueueAccessJob(client,customerId,'policy',String(customerId),version+1,policy,actor,reason);
    return { policy };
  });
}

export async function applySimulationControl(client: PoolClient, customerId: number, sub: { id: string; mode: string; status: string; expires_at: Date | null },
  state: string, actor: string, reason: string, version: number, allowedNow: boolean) {
  await client.query('INSERT INTO billing_subscription_runtime(subscription_id) VALUES($1) ON CONFLICT DO NOTHING',[sub.id]);
  const r = (await client.query('SELECT * FROM billing_subscription_runtime WHERE subscription_id=$1 FOR UPDATE',[sub.id])).rows[0];
  if (r.revoked_at) return;
  let status = 'pending';
  if (sub.mode === 'simulation') {
    if (state !== 'enabled') await closeCustomerSessions(client,customerId,state === 'vacation' ? 'vacation' : 'customer_suspended',actor,{ subscription: sub.id });
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const end = r.effective_expires_at ?? sub.expires_at;
    if (state === 'vacation' && sub.status === 'active' && r.frozen_remaining_ms === null && end && new Date(end)>now) {
      await client.query(`UPDATE billing_subscription_runtime SET frozen_remaining_ms=$2,pause_confirmed_at=$3,applied_state='vacation',updated_at=$3 WHERE subscription_id=$1`,[sub.id,Math.max(0,new Date(end).getTime()-now.getTime()),now]);
      await managementEvent(client,customerId,'pause_confirmed_simulation',actor,reason,{ subscription_id: sub.id,confirmed_at: now,remaining_ms: Math.max(0,new Date(end).getTime()-now.getTime()) });
      status = 'applied_simulation';
    } else if (state !== 'vacation' && r.frozen_remaining_ms !== null && (state === 'suspended' || allowedNow)) {
      await client.query(`UPDATE billing_subscription_runtime SET effective_expires_at=$2,frozen_remaining_ms=NULL,pause_confirmed_at=NULL,applied_state=$3,updated_at=$4 WHERE subscription_id=$1`,[sub.id,new Date(now.getTime()+Number(r.frozen_remaining_ms)),state,now]);
      await managementEvent(client,customerId,'resume_confirmed_simulation',actor,reason,{ subscription_id: sub.id,confirmed_at: now,effective_expires_at: new Date(now.getTime()+Number(r.frozen_remaining_ms)) });
      status = 'applied_simulation';
    } else if (r.frozen_remaining_ms === null || state === 'vacation') {
      await client.query('UPDATE billing_subscription_runtime SET applied_state=$2,updated_at=$3 WHERE subscription_id=$1',[sub.id,state,now]);
      status = 'applied_simulation';
    }
  }
  await enqueueAccessJob(client,customerId,'control',sub.id,version,{ state },actor,reason,status,sub.id);
}

export async function controlCustomer(customerId: number, body: unknown, actor: string) {
  return managementOperation(customerId,'customer_control',body,['version','state','resume_at'],actor,async (client,b,reason) => {
    const version = versionNumber(b.version);
    if (!['enabled','suspended','vacation'].includes(String(b.state))) throw new AccessError(400,'Choose enable, suspend or vacation');
    let resume: Date | null = null;
    if (b.resume_at !== undefined && b.resume_at !== null && b.resume_at !== '') {
      if (b.state !== 'vacation' || typeof b.resume_at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(b.resume_at)) throw new AccessError(400,'Use a timezone-qualified vacation return date');
      resume = new Date(b.resume_at);
      if (!Number.isFinite(resume.getTime()) || resume.getTime()<=Date.now() || resume.getTime()>Date.now()+366*86400000) throw new AccessError(400,'Vacation return must be in the next year');
    }
    const previous = (await client.query('SELECT version FROM billing_customer_controls WHERE customer_id=$1',[customerId])).rows[0]?.version ?? 0;
    if (version !== previous) throw new AccessError(409,'Customer access state changed. Refresh before saving.');
    await client.query(`INSERT INTO billing_customer_controls(customer_id,desired_state,resume_at,version,reason,actor) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(customer_id) DO UPDATE SET desired_state=EXCLUDED.desired_state,resume_at=EXCLUDED.resume_at,version=EXCLUDED.version,reason=EXCLUDED.reason,actor=EXCLUDED.actor,updated_at=clock_timestamp()`,[customerId,b.state,resume,version+1,reason,actor]);
    const subs = (await client.query(`SELECT s.id,s.mode,s.status,s.expires_at FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN}
      WHERE coalesce(p.customer_id,g.customer_id)=$1 ORDER BY s.id FOR UPDATE OF s`,[customerId])).rows;
    const schedule = (await client.query('SELECT schedule FROM billing_access_policy WHERE customer_id=$1',[customerId])).rows[0]?.schedule;
    for (const sub of subs) await applySimulationControl(client,customerId,sub,String(b.state),actor,reason,version+1,scheduleAllows(schedule));
    if (!subs.length) await enqueueAccessJob(client,customerId,'control',`customer:${customerId}`,version+1,{ state: b.state },actor,reason);
    return { desired_state: b.state,version: version+1,resume_at: resume,live_enforcement: 'pending',simulation: 'policy_applied_or_waiting_for_readiness' };
  });
}

export async function revokeComplimentary(customerId: number, subscriptionId: string, body: unknown, actor: string) {
  if (!validUuid(subscriptionId)) throw new AccessError(400,'Invalid subscription ID');
  return managementOperation(customerId,`complimentary_revoked:${subscriptionId}`,body,[],actor,async (client,_b,reason) => {
    const sub = (await client.query(`SELECT s.id,s.mode FROM billing_subscriptions s JOIN billing_access_grants g ON g.id=s.grant_id WHERE s.id=$1 AND g.customer_id=$2 FOR UPDATE OF s`,[subscriptionId,customerId])).rows[0];
    if (!sub) throw new AccessError(404,'Complimentary access not found for this customer');
    const r = (await client.query(`INSERT INTO billing_subscription_runtime(subscription_id,revoked_at,applied_state)
      VALUES($1,clock_timestamp(),$2) ON CONFLICT(subscription_id) DO UPDATE SET revoked_at=coalesce(billing_subscription_runtime.revoked_at,EXCLUDED.revoked_at),
      applied_state=EXCLUDED.applied_state,updated_at=clock_timestamp() RETURNING *`,[subscriptionId,sub.mode === 'simulation' ? 'revoked' : 'unknown'])).rows[0];
    await closeCustomerSessions(client,customerId,'complimentary_revoked',actor,{ subscription: subscriptionId });
    await client.query("UPDATE billing_access_jobs SET status='superseded',updated_at=clock_timestamp() WHERE subscription_id=$1 AND status IN ('pending','failed') AND kind<>'revoke'",[subscriptionId]);
    await enqueueAccessJob(client,customerId,'revoke',subscriptionId,1,{ revoked: true },actor,reason,sub.mode === 'simulation' ? 'applied_simulation' : 'pending',subscriptionId);
    return { revoked_at: r.revoked_at,status: sub.mode === 'simulation' ? 'applied_simulation' : 'pending' };
  });
}
export async function disconnectSessions(customerId: number, body: unknown, actor: string) {
  return managementOperation(customerId,'disconnect',body,['session_id'],actor,async (client,b,reason) => {
    if (b.session_id !== undefined && !validUuid(b.session_id)) throw new AccessError(400,'Invalid session ID');
    if (b.session_id && !(await client.query(`SELECT x.id FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id JOIN billing_subscriptions s ON s.id=a.subscription_id
      ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE x.id=$1 AND coalesce(p.customer_id,g.customer_id)=$2`,[b.session_id,customerId])).rows.length) throw new AccessError(404,'Session not found for this customer');
    // Lock subscriptions before their sessions, consistently with expiry/control.
    await client.query(`SELECT s.id FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE coalesce(p.customer_id,g.customer_id)=$1 ORDER BY s.id FOR UPDATE OF s`,[customerId]);
    const closed = await closeCustomerSessions(client,customerId,'administrator_disconnect',actor,{ session: b.session_id as string | undefined });
    const live = (await client.query(`SELECT s.id FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE coalesce(p.customer_id,g.customer_id)=$1 AND s.mode='live' LIMIT 1`,[customerId])).rows.length>0;
    const status = b.session_id || !live ? 'applied_simulation' : 'pending';
    await enqueueAccessJob(client,customerId,'disconnect',String(b.request_key),1,{ session_id: b.session_id ?? null },actor,reason,status);
    return { closed_simulations: closed,status };
  });
}

export async function queueRenewal(customerId: number, body: unknown, actor: string) {
  return managementOperation(customerId,'renewal_queued',body,['predecessor_id','successor_id'],actor,async (client,b,reason) => {
    if (!validUuid(b.predecessor_id) || !validUuid(b.successor_id) || b.predecessor_id === b.successor_id) throw new AccessError(400,'Choose different current and replacement periods');
    const rows = (await client.query(`SELECT s.*,coalesce(p.customer_id,g.customer_id) AS customer_id,coalesce(p.service_id,g.service_id) AS service_id FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN}
      WHERE s.id=ANY($1::uuid[]) ORDER BY s.id FOR UPDATE OF s`,[[b.predecessor_id,b.successor_id]])).rows;
    const before = rows.find((r) => r.id === b.predecessor_id), after = rows.find((r) => r.id === b.successor_id);
    if (!before || !after || rows.some((r) => r.customer_id !== customerId)) throw new AccessError(404,'Access periods not found for this customer');
    if ((before.service_id ?? null)!==(after.service_id ?? null)) throw new AccessError(409,'Renewal periods must belong to the same customer connection');
    if (before.mode !== after.mode || !before.activation_at || after.activation_at) throw new AccessError(409,'Renewals require matching modes, an activated original period and an unstarted replacement');
    if ((await client.query('SELECT subscription_id FROM billing_subscription_runtime WHERE subscription_id=ANY($1::uuid[]) AND revoked_at IS NOT NULL',[[before.id,after.id]])).rows.length) throw new AccessError(409,'Revoked periods cannot participate in a renewal');
    const cycle = (await client.query(`WITH RECURSIVE chain(id) AS (SELECT $1::uuid UNION SELECT r.successor_id FROM billing_renewals r JOIN chain c ON r.predecessor_id=c.id) SELECT id FROM chain WHERE id=$2`,[after.id,before.id])).rows.length;
    if (cycle) throw new AccessError(409,'Renewals cannot form a cycle');
    await client.query('INSERT INTO billing_renewals(predecessor_id,successor_id,customer_id) VALUES($1,$2,$3)',[before.id,after.id,customerId]);
    await enqueueAccessJob(client,customerId,'renewal',after.id,1,{ predecessor_id: before.id,successor_id: after.id },actor,reason,'pending',after.id);
    return { status: 'queued',predecessor_id: before.id,successor_id: after.id };
  });
}

export async function accessManagementView(customerId: number) {
  if (!(await query('SELECT id FROM billing_customers WHERE id=$1',[customerId])).length) throw new AccessError(404,'Customer not found');
  const [devices,policies,controls,jobs,events,alerts,renewals] = await Promise.all([
    query('SELECT *,mac::text FROM billing_customer_devices WHERE customer_id=$1 ORDER BY created_at DESC',[customerId]),
    query('SELECT * FROM billing_access_policy WHERE customer_id=$1',[customerId]),
    query('SELECT * FROM billing_customer_controls WHERE customer_id=$1',[customerId]),
    query('SELECT j.*,r.state AS worker_state,r.last_code AS worker_code,r.attempts AS worker_attempts FROM billing_access_jobs j LEFT JOIN billing_provisioning_runs r ON r.job_id=j.id WHERE j.customer_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 100',[customerId]),
    query('SELECT * FROM billing_management_events WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[customerId]),
    query('SELECT a.*,s.mode FROM billing_access_alerts a LEFT JOIN billing_subscriptions s ON s.id=a.subscription_id WHERE a.customer_id=$1 AND a.resolved_at IS NULL ORDER BY a.created_at DESC,a.id LIMIT 100',[customerId]),
    query('SELECT * FROM billing_renewals WHERE customer_id=$1 ORDER BY created_at DESC',[customerId]),
  ]);
  const policy = policies[0] ?? { version: 0,max_devices: 5,max_sessions: 1,registered_only: false,schedule: { enabled: false,timezone: 'Africa/Nairobi',windows: [] } };
  return { devices,policy,controls: controls[0] ?? { version: 0,desired_state: 'enabled',resume_at: null },jobs,events,alerts,renewals,
    schedule_allowed_now: scheduleAllows(policy.schedule as Parameters<typeof scheduleAllows>[0]),alert_channel: 'in_app',live_adapter_connected: false };
}
