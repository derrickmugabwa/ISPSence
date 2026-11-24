import { checkReadiness, checkSessionAdmission, lockCustomer, macAddress } from './accessPolicy';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import type { PoolClient } from 'pg';
import { transaction } from '../../config/database';

export const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES billing_access_accounts(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source='simulation'),
  client_ip INET NOT NULL,
  client_mac MACADDR NOT NULL,
  router_label VARCHAR(100) NOT NULL CHECK (length(trim(router_label))>0),
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('test_stopped','subscription_expired')),
  download_bytes BIGINT NOT NULL DEFAULT 0 CHECK (download_bytes BETWEEN 0 AND 9007199254740991),
  upload_bytes BIGINT NOT NULL DEFAULT 0 CHECK (upload_bytes BETWEEN 0 AND 9007199254740991),
  CHECK (updated_at>=started_at),
  CHECK ((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND ended_at>=started_at AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_sessions_active_device_idx ON billing_sessions(account_id,client_mac) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS billing_sessions_history_idx ON billing_sessions(account_id,started_at DESC);
CREATE TABLE IF NOT EXISTS billing_session_events (
  request_key UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES billing_sessions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('start','update','stop')),
  payload JSONB NOT NULL,
  download_bytes BIGINT NOT NULL CHECK (download_bytes BETWEEN 0 AND 9007199254740991),
  upload_bytes BIGINT NOT NULL CHECK (upload_bytes BETWEEN 0 AND 9007199254740991),
  reason TEXT,
  actor TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_session_events_history_idx ON billing_session_events(session_id,recorded_at DESC);
CREATE OR REPLACE FUNCTION protect_billing_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM billing_access_accounts a JOIN billing_subscriptions s ON s.id=a.subscription_id
      WHERE a.id=NEW.account_id AND s.mode='simulation') THEN
      RAISE EXCEPTION 'Test sessions require simulation accounts' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.account_id,NEW.source,NEW.client_ip,NEW.client_mac,NEW.router_label,NEW.started_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.source,OLD.client_ip,OLD.client_mac,OLD.router_label,OLD.started_at)
      OR (OLD.ended_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
      OR NEW.download_bytes<OLD.download_bytes OR NEW.upload_bytes<OLD.upload_bytes OR NEW.updated_at<OLD.updated_at THEN
      RAISE EXCEPTION 'Session identity, closed records and cumulative counters are preserved' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='protect_billing_session' AND tgrelid='billing_sessions'::regclass) THEN
    CREATE TRIGGER protect_billing_session BEFORE INSERT OR UPDATE ON billing_sessions FOR EACH ROW EXECUTE FUNCTION protect_billing_session();
  END IF;
END $$;
`;

export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Start = { action: 'start'; account_id: string; client_ip: string; client_mac: string; router_label: string };
type Change = { action: 'update' | 'stop'; session_id: string; download_bytes: number; upload_bytes: number };
export type SessionCommand = (Start | Change) & { request_key: string };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

export function parseSessionCommand(body: unknown, sessionId?: string): SessionCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SessionError(400, 'Session details are required');
  const b = body as Record<string, unknown>;
  if (b.confirm_simulation !== true || !uuid(b.request_key)) throw new SessionError(400, 'Explicit test confirmation and a valid request key are required');
  const common = ['action','request_key','confirm_simulation'];
  const fields = sessionId ? ['download_bytes','upload_bytes'] : ['account_id','client_ip','client_mac','router_label'];
  if (Object.keys(b).some((k) => ![...common,...fields].includes(k))) throw new SessionError(400, 'Unsupported session field');
  const request_key = b.request_key.toLowerCase();
  if (sessionId) {
    if (!uuid(sessionId) || !['update','stop'].includes(String(b.action)) ||
      ![b.download_bytes,b.upload_bytes].every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v>=0)) {
      throw new SessionError(400, 'Choose update or stop and provide non-negative cumulative byte counters');
    }
    return { request_key, action: b.action as Change['action'], session_id: sessionId.toLowerCase(), download_bytes: b.download_bytes as number, upload_bytes: b.upload_bytes as number };
  }
  if (b.action !== 'start' || !uuid(b.account_id) || typeof b.client_ip !== 'string' || !isIP(b.client_ip) ||
    typeof b.client_mac !== 'string' || !/^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(b.client_mac) ||
    typeof b.router_label !== 'string' || !b.router_label.trim() || b.router_label.trim().length>100) {
    throw new SessionError(400, 'Choose an account and provide a valid IP, MAC address and test router label');
  }
  macAddress(b.client_mac);
  return { request_key, action: 'start', account_id: b.account_id.toLowerCase(), client_ip: b.client_ip, client_mac: b.client_mac.toLowerCase(), router_label: b.router_label.trim() };
}

export async function recordSessionCommand(command: SessionCommand, actor: string) {
  return transaction(async (client) => {
    // Serialize a repeated request even when it targets different accounts. The
    // subscription lock below also serializes distinct starts for one account.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [command.request_key]);
    const payload = JSON.stringify(command);
    const prior = (await client.query('SELECT session_id,payload=$2::jsonb AS matches FROM billing_session_events WHERE request_key=$1', [command.request_key,payload])).rows[0];
    if (prior) {
      if (!prior.matches) throw new SessionError(409, 'This request key was already used for different session details');
      return { session_id: prior.session_id, replayed: true };
    }
    const account = command.action === 'start'
      ? (await client.query(`SELECT a.subscription_id,a.id,coalesce(p.customer_id,g.customer_id) AS customer_id FROM billing_access_accounts a JOIN billing_subscriptions s ON s.id=a.subscription_id LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE a.id=$1`, [command.account_id])).rows[0]
      : (await client.query(`SELECT a.subscription_id,a.id,coalesce(p.customer_id,g.customer_id) AS customer_id FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id JOIN billing_subscriptions s ON s.id=a.subscription_id LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE x.id=$1`, [command.session_id])).rows[0];
    if (!account) throw new SessionError(404, 'Access account or session not found');
    await lockCustomer(client,account.customer_id);
    const sub = (await client.query(`SELECT s.mode,s.status,coalesce(r.effective_expires_at,s.expires_at) AS expires_at FROM billing_subscriptions s LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id WHERE s.id=$1 FOR UPDATE OF s`, [account.subscription_id])).rows[0];
    if (sub.mode !== 'simulation') throw new SessionError(409, 'Test controls cannot operate on live accounts');
    // Obtain server time after the lock so waiting cannot allow a stale start.
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
    if (sub.status !== 'active' || !sub.expires_at || new Date(sub.expires_at)<=new Date(now)) throw new SessionError(409, 'Activate a simulation subscription that has not expired');
    if (command.action !== 'stop') await checkReadiness(client,account.subscription_id,new Date(now));
    let id: string, download = 0, upload = 0;
    if (command.action === 'start') {
      await checkSessionAdmission(client,account.customer_id,command.client_mac);
      if ((await client.query('SELECT id FROM billing_sessions WHERE account_id=$1 AND ended_at IS NULL AND client_mac=$2::macaddr', [account.id,command.client_mac])).rows.length) throw new SessionError(409, 'This account already has an active test session');
      id = randomUUID();
      await client.query(`INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at)
        VALUES($1,$2,'simulation',$3,$4,$5,$6,$6)`, [id,account.id,command.client_ip,command.client_mac,command.router_label,now]);
    } else {
      const session = (await client.query('SELECT * FROM billing_sessions WHERE id=$1 FOR UPDATE', [command.session_id])).rows[0];
      if (session.ended_at) throw new SessionError(409, 'This test session has ended. Start a new session to reconnect.');
      download = command.download_bytes; upload = command.upload_bytes;
      if (download<Number(session.download_bytes) || upload<Number(session.upload_bytes)) throw new SessionError(409, 'Usage counters are cumulative and cannot decrease');
      id = command.session_id;
      await client.query(`UPDATE billing_sessions SET download_bytes=$2,upload_bytes=$3,updated_at=$4,
        ended_at=CASE WHEN $5 THEN $4::timestamptz ELSE NULL END,
        end_reason=CASE WHEN $5 THEN 'test_stopped' ELSE NULL END WHERE id=$1`, [id,download,upload,now,command.action === 'stop']);
    }
    await client.query(`INSERT INTO billing_session_events(request_key,session_id,kind,payload,download_bytes,upload_bytes,reason,actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [command.request_key,id,command.action,payload,download,upload,command.action === 'stop' ? 'test_stopped' : null,actor]);
    return { session_id: id, replayed: false };
  });
}

// Called by subscription expiry in the same transaction, with subscription
// locks already held. Persist the entitlement boundary, not the sweep time.
export async function closeExpiredSessions(client: PoolClient, subscriptions: string[]) {
  await client.query(`WITH closed AS (
    UPDATE billing_sessions x SET ended_at=greatest(x.started_at,coalesce(r.effective_expires_at,s.expires_at)),end_reason='subscription_expired',updated_at=clock_timestamp()
    FROM billing_access_accounts a JOIN billing_subscriptions s ON s.id=a.subscription_id LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    WHERE x.account_id=a.id AND s.id=ANY($1::uuid[]) AND x.ended_at IS NULL AND x.source='simulation'
    RETURNING x.id,x.download_bytes,x.upload_bytes
  ) INSERT INTO billing_session_events(request_key,session_id,kind,payload,download_bytes,upload_bytes,reason,actor)
    SELECT gen_random_uuid(),id,'stop','{"system":"subscription_expired"}'::jsonb,download_bytes,upload_bytes,'subscription_expired','system:simulation-expiry' FROM closed`, [subscriptions]);
}

const joins = `FROM billing_customer_session_history x JOIN billing_customers c ON c.id=x.customer_id`;
const columns = `x.*`;

export async function sessionList(search: string, status: string, offset: number, customerId?: number, filters: {start?:string;end?:string;connectionType?:'all'|'hotspot'|'pppoe';sort?:'recent'|'download'|'upload'|'total_usage'} = {}) {
  const where = `WHERE ($1::text='' OR c.full_name ILIKE $1 OR c.customer_code ILIKE $1 OR x.username ILIKE $1 OR x.payment_reference ILIKE $1
    OR x.client_ip ILIKE $1 OR x.client_mac::text ILIKE $1 OR x.router_label ILIKE $1)
    AND ($2::text='all' OR ($2='active' AND x.ended_at IS NULL) OR ($2='ended' AND x.ended_at IS NOT NULL)) AND ($3::int IS NULL OR c.id=$3)
    AND ($4::date IS NULL OR (x.started_at AT TIME ZONE 'Africa/Nairobi')::date >= $4::date)
    AND ($5::date IS NULL OR (x.started_at AT TIME ZONE 'Africa/Nairobi')::date <= $5::date)
    AND ($6='all' OR x.service_type=$6)`;
  // Escape wildcard characters so user input is a literal substring search.
  const pattern = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : '';
  const order=filters.sort==='download'?'x.download_bytes DESC,x.id':filters.sort==='upload'?'x.upload_bytes DESC,x.id':filters.sort==='total_usage'?'(x.download_bytes+x.upload_bytes) DESC,x.id':'x.started_at DESC,x.id';
  const parameters=[pattern,status,customerId ?? null,filters.start ?? null,filters.end ?? null,filters.connectionType ?? 'all'];
  const [items,summary] = await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL jit = off');
    const items=(await client.query(`SELECT ${columns} ${joins} ${where} ORDER BY ${order} LIMIT 50 OFFSET $7`,[...parameters,offset])).rows;
    const summary=(await client.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE x.ended_at IS NULL)::int AS active,coalesce(sum(x.download_bytes),0)::float8 AS download_bytes,coalesce(sum(x.upload_bytes),0)::float8 AS upload_bytes ${joins} ${where}`,parameters)).rows;
    return [items,summary];
  });
  return { items, summary: summary[0], offset, limit: 50 };
}

export async function sessionDetail(id: string) {
  return transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query('SET LOCAL jit = off');
  const read=async(sql:string,args:unknown[])=>(await client.query(sql,args)).rows;
  const session = (await read(`SELECT ${columns} ${joins} WHERE x.id=$1`, [id]))[0];
  if (!session) throw new SessionError(404, 'Session not found');
  const events = session.source==='radius' ? await read(`SELECT inbox_id AS request_key,CASE kind WHEN 'Start' THEN 'start' WHEN 'Stop' THEN 'stop' ELSE 'update' END AS kind,download_bytes::float8,upload_bytes::float8,quality AS reason,'radius' AS actor,interval_end AS recorded_at FROM billing_accounting_deltas WHERE session_id=$1 ORDER BY interval_end DESC,inbox_id LIMIT 100`,[id]) : await read(`SELECT request_key,kind,download_bytes::float8,upload_bytes::float8,reason,actor,recorded_at FROM billing_session_events WHERE session_id=$1 ORDER BY recorded_at DESC,request_key LIMIT 100`,[id]);
  return { session, events };
  });
}
