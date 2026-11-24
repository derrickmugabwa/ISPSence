import type { PoolClient } from 'pg';
import { SERVICE_FUNDING_SCHEMA } from './serviceFunding';
import { SERVICE_CREDENTIALS_SCHEMA } from './serviceCredentialsSchema';
import { SERVICE_BINDINGS_SCHEMA } from './serviceBindingsSchema';

// Additive foundation only. Existing account/session rows and live-access gates
// remain authoritative until the PPPoE authorization adapter is implemented.
export const CUSTOMER_SERVICES_SCHEMA = `
ALTER TABLE billing_packages ADD COLUMN IF NOT EXISTS service_types TEXT[] NOT NULL DEFAULT ARRAY['hotspot']::text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_package_service_types' AND conrelid='billing_packages'::regclass) THEN
    ALTER TABLE billing_packages ADD CONSTRAINT billing_package_service_types CHECK (
      service_types=ARRAY['hotspot']::text[] OR service_types=ARRAY['pppoe']::text[] OR service_types=ARRAY['hotspot','pppoe']::text[]);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS billing_customer_services (
  id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  service_type TEXT NOT NULL CHECK (service_type IN ('hotspot','pppoe')),
  mode TEXT NOT NULL CHECK (mode IN ('live','simulation')),
  username VARCHAR(64) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN ('draft','legacy')),
  legacy_account_id UUID UNIQUE REFERENCES billing_access_accounts(id) ON DELETE RESTRICT,
  request_key UUID UNIQUE,
  request_payload JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,customer_id),
  CHECK ((service_type='hotspot' AND state='legacy' AND legacy_account_id IS NOT NULL AND request_key IS NULL AND request_payload IS NULL)
    OR (service_type='pppoe' AND state='draft' AND legacy_account_id IS NULL AND request_key IS NOT NULL AND request_payload IS NOT NULL AND jsonb_typeof(request_payload)='object')),
  CHECK (service_type='hotspot' OR (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND username !~ '^(acct_|sim_)'))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_customer_services_username_normalized_key ON billing_customer_services(lower(username));
CREATE INDEX IF NOT EXISTS billing_customer_services_customer_idx ON billing_customer_services(customer_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS billing_service_periods (
  service_id UUID NOT NULL REFERENCES billing_customer_services(id) ON DELETE RESTRICT,
  subscription_id UUID PRIMARY KEY REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_service_periods_service_idx ON billing_service_periods(service_id,subscription_id);
CREATE OR REPLACE FUNCTION preserve_billing_service_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Customer service history must be retained' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.customer_id,NEW.service_type,NEW.mode,NEW.username,NEW.legacy_account_id,NEW.request_key,NEW.request_payload,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.service_type,OLD.mode,OLD.username,OLD.legacy_account_id,OLD.request_key,OLD.request_payload,OLD.created_at) THEN
    RAISE EXCEPTION 'Customer service identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_billing_legacy_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service_type='hotspot' AND NOT EXISTS (
    SELECT 1 FROM billing_access_accounts a JOIN billing_subscriptions s ON s.id=a.subscription_id
    LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
    WHERE a.id=NEW.legacy_account_id AND a.username=NEW.username AND s.mode=NEW.mode
      AND coalesce(p.customer_id,g.customer_id)=NEW.customer_id
      AND coalesce(to_jsonb(p)->>'service_id',to_jsonb(g)->>'service_id') IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy service must match its original customer, account and mode' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_billing_service_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id INTEGER; period_mode TEXT; target billing_customer_services%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Service period history must be retained' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.service_id,NEW.subscription_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.service_id,OLD.subscription_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Service period history is immutable' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(p.customer_id,g.customer_id),s.mode INTO owner_id,period_mode
    FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
    WHERE s.id=NEW.subscription_id;
  SELECT * INTO target FROM billing_customer_services WHERE id=NEW.service_id;
  IF owner_id IS NULL OR target.id IS NULL OR owner_id<>target.customer_id OR period_mode<>target.mode THEN
    RAISE EXCEPTION 'A service and its access period must share a customer and mode' USING ERRCODE='23514';
  END IF;
  IF target.service_type='hotspot' AND NOT EXISTS (SELECT 1 FROM billing_access_accounts a WHERE a.id=target.legacy_account_id AND a.subscription_id=NEW.subscription_id) THEN
    RAISE EXCEPTION 'Legacy service must retain its original access period' USING ERRCODE='23514';
  END IF;
  -- PPPoE period assignment is deliberately gated until funding, package
  -- eligibility, current/queued exclusivity and activation are implemented.
  IF target.service_type='pppoe' THEN
    RAISE EXCEPTION 'PPPoE entitlement assignment is not enabled yet' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_customer_service' AND tgrelid='billing_customer_services'::regclass) THEN
    CREATE TRIGGER immutable_billing_customer_service BEFORE UPDATE OR DELETE ON billing_customer_services FOR EACH ROW EXECUTE FUNCTION preserve_billing_service_identity();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='validate_billing_legacy_service' AND tgrelid='billing_customer_services'::regclass) THEN
    CREATE TRIGGER validate_billing_legacy_service BEFORE INSERT ON billing_customer_services FOR EACH ROW EXECUTE FUNCTION validate_billing_legacy_service();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='validate_billing_service_period' AND tgrelid='billing_service_periods'::regclass) THEN
    CREATE TRIGGER validate_billing_service_period BEFORE INSERT OR UPDATE OR DELETE ON billing_service_periods FOR EACH ROW EXECUTE FUNCTION validate_billing_service_period();
  END IF;
END $$;
-- Reuse original UUIDs in the new table for deterministic, repeatable backfill.
-- Legacy records remain period-specific; never infer shared household logins.
INSERT INTO billing_customer_services(id,customer_id,service_type,mode,username,label,state,legacy_account_id,created_at)
  SELECT a.id,coalesce(p.customer_id,g.customer_id),'hotspot',s.mode,a.username,'Legacy Hotspot access','legacy',a.id,a.created_at
  FROM billing_access_accounts a JOIN billing_subscriptions s ON s.id=a.subscription_id
  LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
  WHERE coalesce(to_jsonb(p)->>'service_id',to_jsonb(g)->>'service_id') IS NULL
    AND NOT EXISTS (SELECT 1 FROM billing_service_periods x WHERE x.subscription_id=s.id)
  ON CONFLICT(id) DO NOTHING;
INSERT INTO billing_service_periods(service_id,subscription_id)
  SELECT a.id,a.subscription_id FROM billing_access_accounts a JOIN billing_customer_services s ON s.legacy_account_id=a.id
  ON CONFLICT(subscription_id) DO NOTHING;
`;

export async function migrateCustomerServices(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(1766261,1)');
    await client.query(CUSTOMER_SERVICES_SCHEMA);
    await client.query(SERVICE_CREDENTIALS_SCHEMA);
    await client.query(SERVICE_FUNDING_SCHEMA);
    await client.query(SERVICE_BINDINGS_SCHEMA);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
