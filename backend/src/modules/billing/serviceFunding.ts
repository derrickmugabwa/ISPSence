import type { PoolClient } from 'pg';
import { AccessError, validUuid } from './accessPolicy';

export function optionalServiceId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!validUuid(value)) throw new AccessError(400,'Choose a valid PPPoE connection');
  return value.toLowerCase();
}
export function supportsService(offer: { service_types?: string[] },type: 'hotspot' | 'pppoe'): boolean {
  return (offer.service_types ?? ['hotspot']).includes(type);
}
export async function validateFundingService(client: PoolClient,id: string | undefined,customerId: number,mode = 'live') {
  if (!id) return;
  const service = (await client.query('SELECT customer_id,service_type,mode,state FROM billing_customer_services WHERE id=$1 FOR SHARE',[id])).rows[0];
  if (!service || service.customer_id!==customerId || service.service_type!=='pppoe' || service.mode!==mode || mode!=='live' || service.state!=='draft') throw new AccessError(409,'Choose a prepared PPPoE connection belonging to this customer. PPPoE simulations are not available.');
}
export async function linkPreparedService(client: PoolClient,subscriptionId: string,serviceId?: string | null) {
  if (!serviceId) return;
  await client.query('INSERT INTO billing_service_periods(service_id,subscription_id) VALUES($1,$2) ON CONFLICT(subscription_id) DO UPDATE SET service_id=EXCLUDED.service_id',[serviceId,subscriptionId]);
}

export const SERVICE_FUNDING_SCHEMA = `
ALTER TABLE billing_purchases ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES billing_customer_services(id) ON DELETE RESTRICT;
ALTER TABLE billing_access_grants ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES billing_customer_services(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS billing_purchases_service_idx ON billing_purchases(service_id) WHERE service_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='billing_service_periods'::regclass AND attname='queue_sequence' AND NOT attisdropped) THEN
    ALTER TABLE billing_service_periods ADD COLUMN queue_sequence BIGSERIAL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS billing_service_periods_sequence_key ON billing_service_periods(queue_sequence);
CREATE OR REPLACE FUNCTION protect_billing_funding_service() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT; allowed TEXT[];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.service_id IS DISTINCT FROM OLD.service_id THEN
      RAISE EXCEPTION 'The funded customer connection is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  kind := coalesce(NEW.package_snapshot->>'service_type','hotspot');
  IF NEW.service_id IS NULL THEN
    IF kind<>'hotspot' OR NEW.package_snapshot->>'service_id' IS NOT NULL THEN
      RAISE EXCEPTION 'PPPoE funding requires a connection' USING ERRCODE='23514';
    END IF;
  ELSE
    IF kind<>'pppoe' OR NEW.package_snapshot->>'service_id' IS DISTINCT FROM NEW.service_id::text OR NOT EXISTS (
      SELECT 1 FROM billing_customer_services s WHERE s.id=NEW.service_id AND s.customer_id=NEW.customer_id
      AND s.service_type='pppoe' AND s.mode='live' AND s.state='draft'
    ) THEN
      RAISE EXCEPTION 'Funding must match the customer and PPPoE connection' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT service_types INTO allowed FROM billing_packages WHERE id=NEW.package_id FOR SHARE;
  IF allowed IS NULL OR NOT (kind=ANY(allowed)) THEN
    RAISE EXCEPTION 'Package is not eligible for the chosen service' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='protect_billing_purchase_service' AND tgrelid='billing_purchases'::regclass) THEN
    CREATE TRIGGER protect_billing_purchase_service BEFORE INSERT OR UPDATE ON billing_purchases FOR EACH ROW EXECUTE FUNCTION protect_billing_funding_service();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='protect_billing_grant_service' AND tgrelid='billing_access_grants'::regclass) THEN
    CREATE TRIGGER protect_billing_grant_service BEFORE INSERT OR UPDATE ON billing_access_grants FOR EACH ROW EXECUTE FUNCTION protect_billing_funding_service();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION validate_billing_service_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id INTEGER; period_mode TEXT; funding_service UUID; period_status TEXT; target billing_customer_services%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Service period history must be retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Service period history is immutable' USING ERRCODE='23514'; END IF;
  SELECT coalesce(p.customer_id,g.customer_id),s.mode,coalesce(p.service_id,g.service_id),s.status
    INTO owner_id,period_mode,funding_service,period_status FROM billing_subscriptions s
    LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE s.id=NEW.subscription_id;
  SELECT * INTO target FROM billing_customer_services WHERE id=NEW.service_id;
  IF owner_id IS NULL OR target.id IS NULL OR owner_id<>target.customer_id OR period_mode<>target.mode THEN
    RAISE EXCEPTION 'A service and its access period must share a customer and mode' USING ERRCODE='23514';
  END IF;
  IF target.service_type='pppoe' THEN
    IF funding_service IS DISTINCT FROM target.id OR period_mode<>'live' OR period_status NOT IN ('awaiting_payment','pending_activation') THEN
      RAISE EXCEPTION 'PPPoE periods require matching funding and pending activation' USING ERRCODE='23514';
    END IF;
  ELSIF funding_service IS NOT NULL OR NOT EXISTS (SELECT 1 FROM billing_access_accounts a WHERE a.id=target.legacy_account_id AND a.subscription_id=NEW.subscription_id) THEN
    RAISE EXCEPTION 'Legacy service must retain its original access period' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
`;
