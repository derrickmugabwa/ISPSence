export const BILLING_REPORTING_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_payment_receipts (
  id UUID PRIMARY KEY,purchase_id UUID NOT NULL UNIQUE REFERENCES billing_purchases(id),
  request_key UUID NOT NULL UNIQUE,method TEXT NOT NULL CHECK(method IN ('payhero','cash','bank_transfer','manual_mpesa')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),reference VARCHAR(160) NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor VARCHAR(150) NOT NULL,notes VARCHAR(500) NOT NULL DEFAULT '',fingerprint TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_receipt_reference ON billing_payment_receipts(method,reference) WHERE reference<>'';
CREATE UNIQUE INDEX IF NOT EXISTS billing_receipt_mpesa_reference ON billing_payment_receipts(upper(reference)) WHERE method IN ('payhero','manual_mpesa') AND reference<>'';
CREATE INDEX IF NOT EXISTS billing_receipt_paid_at ON billing_payment_receipts(paid_at,purchase_id);
INSERT INTO billing_payment_receipts(id,purchase_id,request_key,method,amount_minor,reference,paid_at,actor,notes,fingerprint)
SELECT a.id,p.id,a.id,'payhero',p.amount_minor,a.receipt,a.updated_at,'system:payhero','Imported provider verification time','backfill'
FROM billing_payhero_attempts a JOIN billing_purchases p ON p.id=a.purchase_id
WHERE a.mode='live' AND a.state='succeeded' AND p.payment_status IN ('paid','refunded') AND a.receipt IS NOT NULL
ORDER BY a.updated_at,a.id ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION preserve_billing_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Confirmed payment receipts are immutable' USING ERRCODE='23514'; END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_billing_receipt' AND tgrelid='billing_payment_receipts'::regclass) THEN
    CREATE TRIGGER immutable_billing_receipt BEFORE UPDATE OR DELETE ON billing_payment_receipts FOR EACH ROW EXECUTE FUNCTION preserve_billing_receipt();
  END IF;
END $$;
`;
