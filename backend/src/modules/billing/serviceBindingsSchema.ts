export const SERVICE_BINDINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_pppoe_discoveries (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES billing_customer_services(id) ON DELETE RESTRICT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  service_version INTEGER NOT NULL CHECK(service_version>0),
  inventory JSONB NOT NULL CHECK(jsonb_typeof(inventory)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  UNIQUE(id,service_id,device_id), CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS billing_service_bindings (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES billing_customer_services(id) ON DELETE RESTRICT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  discovery_id UUID NOT NULL,
  server_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  interface_name TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  cpe_mac TEXT CHECK(cpe_mac IS NULL OR cpe_mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
  version INTEGER NOT NULL CHECK(version>1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status='pending'),
  request_key UUID NOT NULL UNIQUE,
  request_payload JSONB NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(service_id,version),
  FOREIGN KEY(discovery_id,service_id,device_id) REFERENCES billing_pppoe_discoveries(id,service_id,device_id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION retain_billing_binding_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Router discovery and binding history is immutable' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION validate_billing_binding_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM billing_customer_services s JOIN billing_pppoe_discoveries d ON d.service_id=s.id
    WHERE s.id=NEW.service_id AND s.service_type='pppoe' AND s.mode='live' AND s.state='draft'
    AND NEW.version=s.version+1 AND d.id=NEW.discovery_id AND d.device_id=NEW.device_id
    AND d.service_version=s.version AND d.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Binding requires a matching prepared PPPoE service and fresh discovery' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_billing_binding_target ON billing_service_bindings;
CREATE TRIGGER validate_billing_binding_target BEFORE INSERT ON billing_service_bindings FOR EACH ROW EXECUTE FUNCTION validate_billing_binding_target();
DROP TRIGGER IF EXISTS retain_billing_binding_history ON billing_service_bindings;
CREATE TRIGGER retain_billing_binding_history BEFORE UPDATE OR DELETE ON billing_service_bindings FOR EACH ROW EXECUTE FUNCTION retain_billing_binding_history();
DROP TRIGGER IF EXISTS retain_billing_discovery_history ON billing_pppoe_discoveries;
CREATE TRIGGER retain_billing_discovery_history BEFORE UPDATE OR DELETE ON billing_pppoe_discoveries FOR EACH ROW EXECUTE FUNCTION retain_billing_binding_history();
`;
