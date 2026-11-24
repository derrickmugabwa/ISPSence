import { optionalServiceId } from './serviceFunding';
export const CUSTOMERS_PAYMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_customers (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL CHECK (length(trim(full_name)) > 0),
  phone VARCHAR(16),
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS customer_code TEXT
  GENERATED ALWAYS AS ('CUS-' || lpad(id::text,greatest(6,length(id::text)),'0')) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_code_key ON billing_customers(customer_code);
CREATE OR REPLACE FUNCTION preserve_billing_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Customer identity and account code are permanent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_customer_identity' AND tgrelid='billing_customers'::regclass) THEN
    CREATE TRIGGER immutable_billing_customer_identity BEFORE UPDATE ON billing_customers FOR EACH ROW EXECUTE FUNCTION preserve_billing_customer_identity();
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS billing_purchases (
  id UUID PRIMARY KEY,
  reference VARCHAR(32) NOT NULL UNIQUE,
  request_key UUID NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  package_id INTEGER NOT NULL REFERENCES billing_packages(id) ON DELETE RESTRICT,
  payer_phone VARCHAR(16) NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'KES'),
  package_snapshot JSONB NOT NULL CHECK (jsonb_typeof(package_snapshot) = 'object'),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','needs_review','refunded')),
  access_status TEXT NOT NULL DEFAULT 'not_activated' CHECK (access_status IN ('not_activated','awaiting_activation','active','expired','needs_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_purchases_customer_idx ON billing_purchases(customer_id, created_at DESC);
CREATE OR REPLACE FUNCTION preserve_billing_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.reference,NEW.request_key,NEW.customer_id,NEW.package_id,NEW.payer_phone,
    NEW.amount_minor,NEW.currency,NEW.package_snapshot,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.reference,OLD.request_key,OLD.customer_id,OLD.package_id,OLD.payer_phone,
    OLD.amount_minor,OLD.currency,OLD.package_snapshot,OLD.created_at) THEN
    RAISE EXCEPTION 'Purchased terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_purchase'
    AND tgrelid='billing_purchases'::regclass) THEN
    CREATE TRIGGER immutable_billing_purchase BEFORE UPDATE ON billing_purchases
      FOR EACH ROW EXECUTE FUNCTION preserve_billing_purchase();
  END IF;
END $$;
`;

export function phoneNumber(value: unknown, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string') throw new Error('Enter a valid phone number');
  let phone = value.replace(/[\s()-]/g, '');
  if (/^0[17]\d{8}$/.test(phone)) phone = `+254${phone.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Use a valid phone number, for example 0712345678 or +254712345678');
  return phone;
}
export function customerInput(body: unknown): { full_name: string; phone: string | null; notes: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Customer details are required');
  const b = body as Record<string, unknown>;
  if ('customer_code' in b) throw new Error('Customer codes are generated automatically and cannot be edited');
  if (typeof b.full_name !== 'string' || !b.full_name.trim() || b.full_name.trim().length > 100) throw new Error('Customer name must be between 1 and 100 characters');
  if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 1000)) throw new Error('Notes must be at most 1000 characters');
  return { full_name: b.full_name.trim(), phone: phoneNumber(b.phone, true), notes: typeof b.notes === 'string' ? b.notes.trim() : '' };
}
export interface PaymentInput { service_id?: string; customer_id: number; package_id: number; package_version: number; payer_phone: string; request_key: string }
export function paymentInput(body: unknown): PaymentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Payment details are required');
  const b = body as Record<string, unknown>;
  for (const value of [b.customer_id, b.package_id, b.package_version]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error('Choose a valid customer and package');
  }
  if (typeof b.request_key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.request_key)) throw new Error('A valid payment request key is required');
  if (['status','payment_status','access_status'].some((key) => key in b)) throw new Error('Payment and access statuses cannot be set manually here');
  const serviceId = optionalServiceId(b.service_id);
  return { ...(serviceId ? { service_id: serviceId } : {}),customer_id: b.customer_id as number, package_id: b.package_id as number, package_version: b.package_version as number,
    payer_phone: phoneNumber(b.payer_phone)!, request_key: b.request_key.toLowerCase() };
}
