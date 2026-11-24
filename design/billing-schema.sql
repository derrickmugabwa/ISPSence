-- Candidate schema only. Not an application migration.
-- Validate using scripts/check-billing-schema.ps1; that runner always rolls back.
CREATE SCHEMA billing_draft;

CREATE TABLE billing_draft.customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text,
  contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_draft.hotspots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id integer NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  router_service text NOT NULL CHECK (length(router_service) > 0),
  billing_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (device_id, router_service)
);
CREATE TABLE billing_draft.packages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(name) > 0),
  enabled boolean NOT NULL DEFAULT true,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
  duration_value integer NOT NULL CHECK (duration_value > 0),
  duration_unit text NOT NULL CHECK (duration_unit IN ('hour','day','week','calendar_month')),
  download_bps bigint NOT NULL CHECK (download_bps > 0),
  upload_bps bigint NOT NULL CHECK (upload_bps > 0),
  allowance_bytes bigint CHECK (allowance_bytes > 0),
  device_limit integer NOT NULL DEFAULT 1 CHECK (device_limit = 1)
);
CREATE TABLE billing_draft.package_hotspots (
  package_id bigint NOT NULL REFERENCES billing_draft.packages(id),
  hotspot_id bigint NOT NULL REFERENCES billing_draft.hotspots(id),
  PRIMARY KEY (package_id, hotspot_id)
);
CREATE TABLE billing_draft.subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES billing_draft.customers(id),
  hotspot_id bigint NOT NULL REFERENCES billing_draft.hotspots(id),
  status text NOT NULL DEFAULT 'pending_activation'
    CHECK (status IN ('pending_activation','active','expired','suspended','cancelled')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (customer_id, hotspot_id),
  UNIQUE (id, customer_id, hotspot_id)
);
CREATE TABLE billing_draft.orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  subscription_id bigint NOT NULL,
  customer_id bigint NOT NULL,
  hotspot_id bigint NOT NULL,
  package_id bigint NOT NULL REFERENCES billing_draft.packages(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'KES'),
  -- Copy validated package terms, timezone, start policy and calendar rule at checkout.
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object' AND terms ?& ARRAY[
    'name','duration_value','duration_unit','download_bps','upload_bps',
    'allowance_bytes','device_limit','timezone','start_policy','calendar_rule']),
  purchase_mode text NOT NULL CHECK (purchase_mode IN ('new','queued_renewal','replace_now')),
  replacement_consent_at timestamptz,
  payment_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment','paid_awaiting_activation','active','fulfilled',
    'expired_unpaid','needs_review','refunded')),
  FOREIGN KEY (subscription_id, customer_id, hotspot_id)
    REFERENCES billing_draft.subscriptions(id, customer_id, hotspot_id),
  FOREIGN KEY (package_id, hotspot_id)
    REFERENCES billing_draft.package_hotspots(package_id, hotspot_id),
  CHECK (purchase_mode <> 'replace_now' OR replacement_consent_at IS NOT NULL),
  CHECK (payment_deadline > created_at),
  UNIQUE (id, subscription_id),
  UNIQUE (id, amount_minor, currency)
);
CREATE TABLE billing_draft.payment_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES billing_draft.orders(id),
  attempt_reference text NOT NULL UNIQUE,
  provider text NOT NULL,
  account_key text NOT NULL,
  channel_key text NOT NULL,
  api_family text NOT NULL,
  payer_phone text NOT NULL,
  provider_reference text,
  checkout_reference text,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN (
    'initiated','pending','uncertain','succeeded','failed','needs_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_key, provider_reference),
  UNIQUE (provider, account_key, checkout_reference),
  UNIQUE (id, order_id)
);
-- Entries are verified financial facts; callbacks alone never create a collection.
CREATE TABLE billing_draft.payment_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id bigint NOT NULL,
  order_id bigint NOT NULL,
  provider text NOT NULL,
  account_key text NOT NULL,
  transaction_reference text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('collection','refund','reversal')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'KES'),
  original_entry_id bigint REFERENCES billing_draft.payment_entries(id),
  evidence_reference text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id, order_id) REFERENCES billing_draft.payment_attempts(id, order_id),
  CHECK ((kind = 'collection' AND original_entry_id IS NULL)
    OR (kind <> 'collection' AND original_entry_id IS NOT NULL)),
  UNIQUE (provider, account_key, transaction_reference, kind),
  UNIQUE (id, order_id, amount_minor, currency, kind)
);
-- A second successful collection is stored but cannot fund the order again.
CREATE TABLE billing_draft.payment_allocations (
  order_id bigint PRIMARY KEY,
  entry_id bigint NOT NULL UNIQUE,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  kind text NOT NULL DEFAULT 'collection' CHECK (kind = 'collection'),
  FOREIGN KEY (order_id, amount_minor, currency)
    REFERENCES billing_draft.orders(id, amount_minor, currency),
  FOREIGN KEY (entry_id, order_id, amount_minor, currency, kind)
    REFERENCES billing_draft.payment_entries(id, order_id, amount_minor, currency, kind)
);
CREATE TABLE billing_draft.access_periods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE,
  subscription_id bigint NOT NULL,
  replaces_period_id bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','scheduled','active','expired','forfeited','cancelled')),
  proposed_start_at timestamptz,
  proposed_expires_at timestamptz,
  activation_at timestamptz,
  expires_at timestamptz,
  allowance_bytes bigint CHECK (allowance_bytes > 0),
  consumed_bytes bigint NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0),
  FOREIGN KEY (order_id, subscription_id)
    REFERENCES billing_draft.orders(id, subscription_id),
  UNIQUE (id, subscription_id),
  FOREIGN KEY (replaces_period_id, subscription_id)
    REFERENCES billing_draft.access_periods(id, subscription_id),
  CHECK ((proposed_start_at IS NULL AND proposed_expires_at IS NULL)
    OR (proposed_start_at IS NOT NULL AND proposed_expires_at IS NOT NULL
      AND proposed_expires_at > proposed_start_at)),
  CHECK ((activation_at IS NULL AND expires_at IS NULL)
    OR (activation_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > activation_at)),
  CHECK (status NOT IN ('active','expired','forfeited') OR activation_at IS NOT NULL),
  CHECK (replaces_period_id IS NULL OR replaces_period_id <> id)
);
CREATE UNIQUE INDEX one_active_period ON billing_draft.access_periods(subscription_id)
  WHERE status = 'active';
CREATE TABLE billing_draft.provisioning_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_id bigint NOT NULL REFERENCES billing_draft.access_periods(id),
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('activate','replace','suspend','expire','reconcile')),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','in_progress','confirmed','retry_pending','uncertain','failed','superseded')),
  desired_state jsonb NOT NULL,
  observed_state jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_error text,
  confirmed_at timestamptz
);
CREATE TABLE billing_draft.provider_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  account_key text NOT NULL,
  receipt_key text NOT NULL,
  attempt_id bigint REFERENCES billing_draft.payment_attempts(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','rejected','needs_review')),
  payload jsonb NOT NULL,
  UNIQUE (provider, account_key, receipt_key)
);
CREATE TABLE billing_draft.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  order_id bigint NOT NULL REFERENCES billing_draft.orders(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE TABLE billing_draft.business_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  order_id bigint REFERENCES billing_draft.orders(id),
  actor_type text NOT NULL CHECK (actor_type IN ('staff','customer','provider','worker')),
  actor_reference text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION billing_draft.preserve_order_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.reference,NEW.subscription_id,NEW.customer_id,NEW.hotspot_id,NEW.package_id,
    NEW.amount_minor,NEW.currency,NEW.terms,NEW.purchase_mode,NEW.replacement_consent_at,
    NEW.payment_deadline,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.reference,OLD.subscription_id,OLD.customer_id,OLD.hotspot_id,OLD.package_id,
    OLD.amount_minor,OLD.currency,OLD.terms,OLD.purchase_mode,OLD.replacement_consent_at,
    OLD.payment_deadline,OLD.created_at) THEN
    RAISE EXCEPTION 'Purchased terms cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_terms BEFORE UPDATE ON billing_draft.orders
  FOR EACH ROW EXECUTE FUNCTION billing_draft.preserve_order_terms();

CREATE FUNCTION billing_draft.preserve_effective_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.activation_at IS NOT NULL AND
    ROW(NEW.activation_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.activation_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Confirmed effective timestamps cannot be reset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_effective_time BEFORE UPDATE ON billing_draft.access_periods
  FOR EACH ROW EXECUTE FUNCTION billing_draft.preserve_effective_time();

CREATE FUNCTION billing_draft.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Financial entries and business events are append only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_payment_entry BEFORE UPDATE OR DELETE ON billing_draft.payment_entries
  FOR EACH ROW EXECUTE FUNCTION billing_draft.append_only();
CREATE TRIGGER immutable_business_event BEFORE UPDATE OR DELETE ON billing_draft.business_events
  FOR EACH ROW EXECUTE FUNCTION billing_draft.append_only();
