export const SERVICE_CREDENTIALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_service_credentials (
  service_id UUID PRIMARY KEY REFERENCES billing_customer_services(id) ON DELETE RESTRICT,
  password_encrypted TEXT NOT NULL CHECK (password_encrypted ~ '^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$'),
  revision INTEGER NOT NULL CHECK (revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS billing_service_credential_requests (
  request_key UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES billing_customer_services(id) ON DELETE RESTRICT,
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  result_version INTEGER NOT NULL CHECK (result_version>1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(service_id,result_version)
);
CREATE OR REPLACE FUNCTION validate_billing_service_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM billing_customer_services s WHERE s.id=NEW.service_id AND s.service_type='pppoe' AND s.state='draft') THEN
    RAISE EXCEPTION 'Credentials require a draft PPPoE service' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision<OLD.revision) THEN
    RAISE EXCEPTION 'Credential identity and revision must be preserved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='validate_billing_service_credentials' AND tgrelid='billing_service_credentials'::regclass) THEN
    CREATE TRIGGER validate_billing_service_credentials BEFORE INSERT OR UPDATE ON billing_service_credentials FOR EACH ROW EXECUTE FUNCTION validate_billing_service_credentials();
  END IF;
END $$;
`;
