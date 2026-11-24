import { optionalServiceId, supportsService, validateFundingService, linkPreparedService } from './serviceFunding';
import { enqueueAccessJob } from './accessManagement';
import { randomUUID } from 'crypto';
import { query, transaction } from '../../config/database';

export const CUSTOMER_ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_access_grants (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  request_key UUID NOT NULL UNIQUE,
  request_payload JSONB NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  package_id INTEGER NOT NULL REFERENCES billing_packages(id) ON DELETE RESTRICT,
  package_snapshot JSONB NOT NULL CHECK (jsonb_typeof(package_snapshot)='object'),
  charge_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (charge_amount_minor=0),
  reason VARCHAR(500) NOT NULL CHECK (length(trim(reason))>0),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE billing_subscriptions ALTER COLUMN purchase_id DROP NOT NULL;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS grant_id UUID UNIQUE REFERENCES billing_access_grants(id) ON DELETE RESTRICT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_subscription_funding' AND conrelid='billing_subscriptions'::regclass) THEN
    ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscription_funding CHECK (num_nonnulls(purchase_id,grant_id)=1);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS billing_access_grants_customer_idx ON billing_access_grants(customer_id,created_at DESC);
CREATE OR REPLACE FUNCTION preserve_billing_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.purchase_id,NEW.grant_id,NEW.mode,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.purchase_id,OLD.grant_id,OLD.mode,OLD.created_at)
    OR (OLD.activation_at IS NOT NULL AND ROW(NEW.activation_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.activation_at,OLD.expires_at)) THEN
    RAISE EXCEPTION 'Subscription funding, identity and confirmed timestamps are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION preserve_billing_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Complimentary access grants are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_grant' AND tgrelid='billing_access_grants'::regclass) THEN
    CREATE TRIGGER immutable_billing_grant BEFORE UPDATE ON billing_access_grants FOR EACH ROW EXECUTE FUNCTION preserve_billing_grant();
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS billing_customer_network (
  customer_id INTEGER PRIMARY KEY REFERENCES billing_customers(id) ON DELETE RESTRICT,
  download_bps BIGINT CHECK (download_bps BETWEEN 1 AND 1000000000000),
  upload_bps BIGINT CHECK (upload_bps BETWEEN 1 AND 1000000000000),
  reason VARCHAR(500) NOT NULL CHECK (length(trim(reason))>0),
  actor TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((download_bps IS NULL)=(upload_bps IS NULL))
);
CREATE TABLE IF NOT EXISTS billing_customer_network_events (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  download_bps BIGINT,
  upload_bps BIGINT,
  reason VARCHAR(500) NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(customer_id,version)
);
`;

export class CustomerAccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const integer = (v: unknown, max = 2147483647): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v>0 && v<=max;
const reason = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length>500) throw new CustomerAccessError(400,'Enter a reason between 1 and 500 characters');
  return v.trim();
};
export function parseOverride(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CustomerAccessError(400,'Speed settings are required');
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some((k) => !['download_bps','upload_bps','reason','version'].includes(k))) throw new CustomerAccessError(400,'Unsupported speed override field');
  if (!Number.isInteger(b.version) || (b.version as number)<0 || (b.version as number)>=2147483647) throw new CustomerAccessError(400,'A valid settings version is required');
  const reset = b.download_bps === null && b.upload_bps === null;
  if (!reset && (!integer(b.download_bps,1e12) || !integer(b.upload_bps,1e12))) throw new CustomerAccessError(400,'Set both download and upload speeds, or clear both to restore package speeds');
  return { version: b.version as number,download_bps: b.download_bps as number | null,upload_bps: b.upload_bps as number | null,reason: reason(b.reason) };
}
export function parseGrant(body: unknown, customerId: number) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CustomerAccessError(400,'Complimentary access details are required');
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some((k) => !['package_id','package_version','reason','mode','request_key','confirm_complimentary','confirm_simulation','service_id'].includes(k))) throw new CustomerAccessError(400,'Unsupported complimentary access field');
  if (b.confirm_complimentary !== true || !integer(b.package_id) || !integer(b.package_version) ||
    (b.mode !== undefined && b.mode !== 'live') ||
    typeof b.request_key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.request_key)) {
    throw new CustomerAccessError(400,'Choose a package and explicitly confirm complimentary access');
  }
  const serviceId = optionalServiceId(b.service_id);
  return { ...(serviceId ? { service_id: serviceId } : {}),customer_id: customerId,package_id: b.package_id as number,package_version: b.package_version as number,
    reason: reason(b.reason),mode: 'live' as const,request_key: b.request_key.toLowerCase() };
}

export async function grantComplimentary(input: ReturnType<typeof parseGrant>, actor: string) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[input.request_key]);
    const payload = JSON.stringify(input);
    const prior = (await client.query(`SELECT g.id,s.id AS subscription_id,g.request_payload=$2::jsonb AS matches
      FROM billing_access_grants g JOIN billing_subscriptions s ON s.grant_id=g.id WHERE g.request_key=$1`,[input.request_key,payload])).rows[0];
    if (prior) {
      if (!prior.matches) throw new CustomerAccessError(409,'This request key was used for different complimentary access details');
      return { id: prior.id,subscription_id: prior.subscription_id,replayed: true };
    }
    if (!(await client.query('SELECT id FROM billing_customers WHERE id=$1 FOR KEY SHARE',[input.customer_id])).rows.length) throw new CustomerAccessError(404,'Customer not found');
    const offer = (await client.query(`SELECT *,download_bps::float8,upload_bps::float8,allowance_bytes::float8 FROM billing_packages WHERE id=$1 FOR SHARE`,[input.package_id])).rows[0];
    if (!offer || !offer.enabled || offer.version !== input.package_version) throw new CustomerAccessError(409,'Package changed or is disabled. Refresh and choose it again.');
    const serviceType = input.service_id ? 'pppoe' : 'hotspot';
    if (!supportsService(offer,serviceType)) throw new CustomerAccessError(409,'Choose a package compatible with the selected connection type');
    await validateFundingService(client,input.service_id,input.customer_id,input.mode);
    const snapshot = { fup_policy: offer.fup_policy ?? null, service_type: serviceType,...(input.service_id ? { service_id: input.service_id } : {}),name: offer.name,package_id: offer.id,package_version: offer.version,amount_minor: offer.amount_minor,currency: offer.currency,
      duration_value: offer.duration_value,duration_unit: offer.duration_unit,download_bps: offer.download_bps,upload_bps: offer.upload_bps,
      allowance_bytes: offer.allowance_bytes,device_limit: 1,timezone: process.env.TZ || 'UTC',start_policy: 'access_ready',calendar_rule: 'clamp_to_last_day' };
    const id = randomUUID(), subscription = randomUUID();
    await client.query(`INSERT INTO billing_access_grants(id,reference,request_key,request_payload,customer_id,package_id,package_snapshot,reason,actor,service_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,`FREE-${id}`,input.request_key,payload,input.customer_id,input.package_id,JSON.stringify(snapshot),input.reason,actor,input.service_id ?? null]);
    await client.query("INSERT INTO billing_subscriptions(id,grant_id,mode,status) VALUES($1,$2,$3,'pending_activation')",[subscription,id,input.mode]);
    await client.query('INSERT INTO billing_access_accounts(id,subscription_id,username) VALUES($1,$2,$3)',[randomUUID(),subscription,`acct_${subscription.replace(/-/g,'')}`]);
    await linkPreparedService(client,subscription,input.service_id);
    await client.query("INSERT INTO billing_access_events(subscription_id,kind,actor) VALUES($1,'prepared',$2)",[subscription,actor]);
    await enqueueAccessJob(client,input.customer_id,'prepare',subscription,1,{ mode: input.mode },actor,input.reason,'pending',subscription);
    return { id,subscription_id: subscription,replayed: false };
  });
}

export async function saveOverride(customerId: number, input: ReturnType<typeof parseOverride>, actor: string) {
  return transaction(async (client) => {
    if (!(await client.query('SELECT id FROM billing_customers WHERE id=$1 FOR UPDATE',[customerId])).rows.length) throw new CustomerAccessError(404,'Customer not found');
    const previous = (await client.query('SELECT *,download_bps::float8,upload_bps::float8 FROM billing_customer_network WHERE customer_id=$1',[customerId])).rows[0];
    if ((previous?.version ?? 0) !== input.version) {
      // A network retry may repeat a save after its response was lost.
      if (previous?.version === input.version+1 && Number(previous.download_bps ?? 0) === (input.download_bps ?? 0) && Number(previous.upload_bps ?? 0) === (input.upload_bps ?? 0) && previous.reason === input.reason && previous.actor === actor) return previous;
      throw new CustomerAccessError(409,'Speed settings changed. Refresh this customer before saving.');
    }
    const saved = (await client.query(`INSERT INTO billing_customer_network(customer_id,download_bps,upload_bps,reason,actor,version)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id) DO UPDATE SET download_bps=EXCLUDED.download_bps,upload_bps=EXCLUDED.upload_bps,
      reason=EXCLUDED.reason,actor=EXCLUDED.actor,version=EXCLUDED.version,updated_at=clock_timestamp()
      RETURNING *,download_bps::float8,upload_bps::float8`,[customerId,input.download_bps,input.upload_bps,input.reason,actor,input.version+1])).rows[0];
    await client.query('INSERT INTO billing_customer_network_events(customer_id,version,download_bps,upload_bps,reason,actor) VALUES($1,$2,$3,$4,$5,$6)',[customerId,saved.version,input.download_bps,input.upload_bps,input.reason,actor]);
    await enqueueAccessJob(client,customerId,'speed',String(customerId),saved.version,{ download_bps: input.download_bps,upload_bps: input.upload_bps },actor,input.reason);
    return saved;
  });
}

export async function customerProfile(customerId: number) {
  const customer = (await query(`SELECT c.*,(SELECT count(*)::int FROM billing_purchases p WHERE p.customer_id=c.id) AS payment_count FROM billing_customers c WHERE c.id=$1`,[customerId]))[0];
  if (!customer) throw new CustomerAccessError(404,'Customer not found');
  const [settings,history] = await Promise.all([
    query('SELECT *,download_bps::float8,upload_bps::float8 FROM billing_customer_network WHERE customer_id=$1',[customerId]),
    query('SELECT *,download_bps::float8,upload_bps::float8 FROM billing_customer_network_events WHERE customer_id=$1 ORDER BY version DESC LIMIT 50',[customerId]),
  ]);
  return { customer,network: settings[0] ?? { customer_id: customerId,version: 0,download_bps: null,upload_bps: null,reason: null,actor: null,updated_at: null },network_history: history,enforcement: 'not_applied' };
}
