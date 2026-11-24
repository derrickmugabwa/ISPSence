// Deliberately absent from db/migrate.ts. Only disposable pp... lab schemas may
// install these records; the production live-activation constraints stay intact.
export const PPPOE_LAB_SCHEMA = `
CREATE TABLE IF NOT EXISTS pppoe_lab_enrollments (
  service_id UUID PRIMARY KEY REFERENCES billing_customer_services(id),
  binding_version INTEGER NOT NULL, nas TEXT NOT NULL, source_ip INET NOT NULL CHECK(source_ip='127.0.0.1'),
  ready BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS pppoe_lab_periods (
  subscription_id UUID PRIMARY KEY REFERENCES billing_subscriptions(id),
  service_id UUID NOT NULL REFERENCES billing_customer_services(id),
  activation_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,confirmed_at TIMESTAMPTZ,
  CHECK((activation_at IS NULL AND expires_at IS NULL) OR expires_at>activation_at)
);
CREATE TABLE IF NOT EXISTS pppoe_lab_admissions (
  id UUID PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, policy_digest TEXT NOT NULL, service_version INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id), service_id UUID NOT NULL REFERENCES billing_customer_services(id),
  subscription_id UUID NOT NULL REFERENCES billing_subscriptions(id),
  nas TEXT NOT NULL, source_ip INET NOT NULL, cpe_mac TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','started','uncertain','stopped','never_enabled')),
  proposed_at TIMESTAMPTZ NOT NULL, admission_deadline TIMESTAMPTZ NOT NULL, lease_until TIMESTAMPTZ NOT NULL,
  session_key TEXT, started_at TIMESTAMPTZ, stopped_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
  download_bytes BIGINT NOT NULL DEFAULT 0 CHECK(download_bytes>=0), upload_bytes BIGINT NOT NULL DEFAULT 0 CHECK(upload_bytes>=0),
  elapsed_seconds BIGINT NOT NULL DEFAULT 0 CHECK(elapsed_seconds>=0),client_ip INET,
  UNIQUE(nas,source_ip,session_key), CHECK(admission_deadline>proposed_at AND lease_until>admission_deadline)
);
CREATE INDEX IF NOT EXISTS pppoe_lab_capacity ON pppoe_lab_admissions(customer_id,state);
CREATE TABLE IF NOT EXISTS pppoe_lab_packets (
  fingerprint TEXT PRIMARY KEY, admission_id UUID NOT NULL REFERENCES pppoe_lab_admissions(id),
  kind TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS pppoe_lab_fences (
  service_id UUID PRIMARY KEY REFERENCES billing_customer_services(id),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
CREATE TABLE IF NOT EXISTS pppoe_lab_operations (
  id UUID PRIMARY KEY, request_key UUID NOT NULL UNIQUE,
  service_id UUID NOT NULL REFERENCES billing_customer_services(id),
  admission_id UUID NOT NULL UNIQUE REFERENCES pppoe_lab_admissions(id),
  binding_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','applying','verifying','uncertain','retry','confirmed','never_enabled','attention')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_token UUID, lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, result_code TEXT NOT NULL DEFAULT 'queued',
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pppoe_lab_one_transition ON pppoe_lab_operations(service_id)
  WHERE state NOT IN ('confirmed','never_enabled');
CREATE TABLE IF NOT EXISTS pppoe_lab_operation_events (
  sequence BIGSERIAL PRIMARY KEY, operation_id UUID NOT NULL REFERENCES pppoe_lab_operations(id),
  state TEXT NOT NULL, code TEXT NOT NULL, generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL, occurred_at TIMESTAMPTZ NOT NULL
);
CREATE OR REPLACE FUNCTION preserve_pppoe_lab_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.activation_at IS NOT NULL AND ROW(NEW.activation_at,NEW.expires_at,NEW.confirmed_at) IS DISTINCT FROM ROW(OLD.activation_at,OLD.expires_at,OLD.confirmed_at) THEN
    RAISE EXCEPTION 'Confirmed lab timestamps are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_pppoe_lab_times ON pppoe_lab_periods;
CREATE TRIGGER preserve_pppoe_lab_times BEFORE UPDATE ON pppoe_lab_periods FOR EACH ROW EXECUTE FUNCTION preserve_pppoe_lab_times();
`;
