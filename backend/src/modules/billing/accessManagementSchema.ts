export const ACCESS_MANAGEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_customer_devices (
  id UUID PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  label VARCHAR(100) NOT NULL CHECK (length(trim(label))>0),mac MACADDR NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id,mac)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_customer_devices_active_mac ON billing_customer_devices(mac) WHERE enabled;
CREATE INDEX IF NOT EXISTS billing_customer_devices_customer_idx ON billing_customer_devices(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_access_policy (
  customer_id INTEGER PRIMARY KEY REFERENCES billing_customers(id) ON DELETE RESTRICT,
  max_devices INTEGER NOT NULL DEFAULT 5 CHECK(max_devices BETWEEN 1 AND 50),
  max_sessions INTEGER NOT NULL DEFAULT 1 CHECK(max_sessions BETWEEN 1 AND 20),
  registered_only BOOLEAN NOT NULL DEFAULT false,
  schedule JSONB NOT NULL DEFAULT '{"enabled":false,"timezone":"Africa/Nairobi","windows":[]}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_customer_controls (
  customer_id INTEGER PRIMARY KEY REFERENCES billing_customers(id) ON DELETE RESTRICT,
  desired_state TEXT NOT NULL CHECK(desired_state IN ('enabled','suspended','vacation')),
  resume_at TIMESTAMPTZ,version INTEGER NOT NULL CHECK(version>0),reason VARCHAR(500) NOT NULL,actor TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_subscription_runtime (
  subscription_id UUID PRIMARY KEY REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  effective_expires_at TIMESTAMPTZ,frozen_remaining_ms BIGINT CHECK(frozen_remaining_ms>=0),pause_confirmed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,applied_state TEXT NOT NULL DEFAULT 'unknown' CHECK(applied_state IN ('unknown','enabled','suspended','vacation','revoked')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((frozen_remaining_ms IS NULL)=(pause_confirmed_at IS NULL))
);
CREATE TABLE IF NOT EXISTS billing_access_jobs (
  id UUID PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  subscription_id UUID REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,scope_key TEXT NOT NULL,version INTEGER NOT NULL,desired JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','applied_simulation','failed','superseded')),
  reason VARCHAR(500) NOT NULL,actor TEXT NOT NULL,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(kind,scope_key,version)
);
CREATE INDEX IF NOT EXISTS billing_access_jobs_customer_idx ON billing_access_jobs(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_management_events (
  id BIGSERIAL PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,reason VARCHAR(500) NOT NULL,actor TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_management_events_customer_idx ON billing_management_events(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_management_requests (
  request_key UUID PRIMARY KEY,payload JSONB NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_access_alerts (
  id UUID PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  subscription_id UUID REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('expiry_soon','expired','provisioning_failed')),message TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,
  deadline TIMESTAMPTZ,read_at TIMESTAMPTZ,resolved_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_access_alerts_customer_idx ON billing_access_alerts(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_renewals (
  predecessor_id UUID PRIMARY KEY REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  successor_id UUID NOT NULL UNIQUE REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','applied_simulation','pending_live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(predecessor_id<>successor_id)
);
CREATE INDEX IF NOT EXISTS billing_renewals_customer_idx ON billing_renewals(customer_id,created_at DESC);
ALTER TABLE billing_sessions DROP CONSTRAINT IF EXISTS billing_sessions_end_reason_check;
ALTER TABLE billing_sessions ADD CONSTRAINT billing_sessions_end_reason_check CHECK(end_reason IN
  ('test_stopped','subscription_expired','customer_suspended','vacation','complimentary_revoked','schedule_closed','device_disabled','administrator_disconnect'));
DROP INDEX IF EXISTS billing_sessions_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS billing_sessions_active_device_idx ON billing_sessions(account_id,client_mac) WHERE ended_at IS NULL;
`;
