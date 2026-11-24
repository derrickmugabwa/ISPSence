import { BILLING_REPORTING_SCHEMA } from './billingReportingSchema';
export const PAYHERO_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_payhero_configs (
  id SERIAL PRIMARY KEY,enabled BOOLEAN NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  base_url TEXT NOT NULL,channel_id INTEGER NOT NULL CHECK(channel_id>0),account_id INTEGER,
  public_origin TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,actor TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_payhero_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),config_id INTEGER REFERENCES billing_payhero_configs(id),version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO billing_payhero_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS billing_payhero_attempts (
  id UUID PRIMARY KEY,purchase_id UUID NOT NULL REFERENCES billing_purchases(id),config_id INTEGER NOT NULL REFERENCES billing_payhero_configs(id),
  request_key UUID NOT NULL UNIQUE,mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  external_reference TEXT NOT NULL UNIQUE,provider_reference TEXT,checkout_id TEXT,receipt TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','pending','uncertain','succeeded','failed','review')),
  callback_hash TEXT NOT NULL,callback_secret_encrypted TEXT,
  last_error TEXT,checks INTEGER NOT NULL DEFAULT 0,next_check_at TIMESTAMPTZ DEFAULT now(),locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(mode,provider_reference)
);
CREATE INDEX IF NOT EXISTS billing_payhero_attempts_due ON billing_payhero_attempts(next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_payhero_attempts_purchase ON billing_payhero_attempts(purchase_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_payhero_callbacks (
  id BIGSERIAL PRIMARY KEY,attempt_id UUID NOT NULL REFERENCES billing_payhero_attempts(id),digest TEXT NOT NULL,
  payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(attempt_id,digest)
);
CREATE TABLE IF NOT EXISTS billing_payhero_receipts (
  mode TEXT NOT NULL,receipt TEXT NOT NULL,attempt_id UUID NOT NULL UNIQUE REFERENCES billing_payhero_attempts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(mode,receipt)
);
CREATE TABLE IF NOT EXISTS billing_payhero_checkouts (
  purchase_id UUID PRIMARY KEY REFERENCES billing_purchases(id),portal_id INTEGER NOT NULL REFERENCES billing_portals(id),
  token_hash TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE billing_payhero_checkouts ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sandbox' CHECK(mode IN ('sandbox','live'));
CREATE TABLE IF NOT EXISTS billing_payhero_events (
  id BIGSERIAL PRIMARY KEY,attempt_id UUID REFERENCES billing_payhero_attempts(id),kind TEXT NOT NULL,actor TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_payhero_channel_registrations (
  target_key TEXT PRIMARY KEY,request_key UUID NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),actor TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','uncertain')),
  channel JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION preserve_payhero_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.purchase_id,NEW.config_id,NEW.request_key,NEW.mode,NEW.external_reference,NEW.callback_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.purchase_id,OLD.config_id,OLD.request_key,OLD.mode,OLD.external_reference,OLD.callback_hash,OLD.created_at)
    OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
    OR (OLD.checkout_id IS NOT NULL AND NEW.checkout_id IS DISTINCT FROM OLD.checkout_id)
    OR (OLD.state='succeeded' AND NEW.state<>'succeeded') OR (OLD.state<>'queued' AND NEW.state='queued') THEN
    RAISE EXCEPTION 'Payment attempt identity and confirmed provider references are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_payhero_attempt' AND tgrelid='billing_payhero_attempts'::regclass) THEN
    CREATE TRIGGER immutable_payhero_attempt BEFORE UPDATE ON billing_payhero_attempts FOR EACH ROW EXECUTE FUNCTION preserve_payhero_attempt();
  END IF;
END $$;
${BILLING_REPORTING_SCHEMA}
`;
