-- Executed only inside the runner's rollback transaction.
CREATE FUNCTION pg_temp.expect_error(statement text, expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
  END;
  IF actual_state IS DISTINCT FROM expected_state THEN
    RAISE EXCEPTION 'Expected SQLSTATE %, got % for %', expected_state, actual_state, statement;
  END IF;
END $$;

-- Fake inventory row only: explicit id avoids advancing the application's sequence.
INSERT INTO public.devices(id,name,ip_address,api_username,api_password_encrypted)
VALUES (-2147483000,'billing-schema-rollback-fixture','192.0.2.1','not-used','not-a-real-credential');
INSERT INTO billing_draft.customers(display_name) VALUES ('Fixture subscriber');
INSERT INTO billing_draft.hotspots(device_id,router_service) VALUES (-2147483000,'fixture-hotspot');
INSERT INTO billing_draft.packages(name,amount_minor,duration_value,duration_unit,download_bps,upload_bps)
VALUES ('One hour',1000,1,'hour',5000000,2000000);
INSERT INTO billing_draft.package_hotspots VALUES (1,1);
INSERT INTO billing_draft.subscriptions(customer_id,hotspot_id) VALUES (1,1);
INSERT INTO billing_draft.orders(reference,subscription_id,customer_id,hotspot_id,package_id,
  amount_minor,currency,terms,purchase_mode,payment_deadline)
SELECT 'fixture-order',1,1,1,id,amount_minor,currency,
  jsonb_build_object('name',name,'duration_value',duration_value,'duration_unit',duration_unit,
    'download_bps',download_bps,'upload_bps',upload_bps,'allowance_bytes',allowance_bytes,
    'device_limit',device_limit,'timezone','Africa/Nairobi','start_policy','access_ready',
    'calendar_rule','clamp_to_last_day'),'new',now()+interval '15 minutes'
FROM billing_draft.packages WHERE id=1;
UPDATE billing_draft.packages SET amount_minor=2000 WHERE id=1;
DO $$ BEGIN
  IF (SELECT amount_minor FROM billing_draft.orders WHERE id=1) <> 1000 THEN
    RAISE EXCEPTION 'Package update changed order price';
  END IF;
END $$;
SELECT pg_temp.expect_error('UPDATE billing_draft.orders SET amount_minor=2000 WHERE id=1','23514');
SELECT pg_temp.expect_error('UPDATE billing_draft.orders SET terms=''{}'' WHERE id=1','23514');
\echo PASS: frozen purchase price and terms

INSERT INTO billing_draft.payment_attempts(order_id,attempt_reference,provider,account_key,
  channel_key,api_family,payer_phone,provider_reference,status)
VALUES (1,'fixture-attempt','simulated','fixture-account','fixture-channel','simulation',
  'fixture-payer','fixture-provider-ref','succeeded');
INSERT INTO billing_draft.payment_entries(attempt_id,order_id,provider,account_key,
  transaction_reference,kind,amount_minor,currency,evidence_reference)
VALUES (1,1,'simulated','fixture-account','fixture-receipt','collection',1000,'KES','simulation-only');
SELECT pg_temp.expect_error($s$INSERT INTO billing_draft.payment_entries(attempt_id,order_id,
  provider,account_key,transaction_reference,kind,amount_minor,currency,evidence_reference)
  VALUES (1,1,'simulated','fixture-account','fixture-receipt','collection',1000,'KES','duplicate')$s$,'23505');
INSERT INTO billing_draft.payment_allocations(order_id,entry_id,amount_minor,currency) VALUES (1,1,1000,'KES');
INSERT INTO billing_draft.outbox(event_key,order_id,event_type,payload)
VALUES ('order:1:paid',1,'payment.allocated','{}') ON CONFLICT(event_key) DO NOTHING;
INSERT INTO billing_draft.outbox(event_key,order_id,event_type,payload)
VALUES ('order:1:paid',1,'payment.allocated','{}') ON CONFLICT(event_key) DO NOTHING;
UPDATE billing_draft.orders SET status='paid_awaiting_activation' WHERE id=1;
INSERT INTO billing_draft.access_periods(order_id,subscription_id) VALUES (1,1);
DO $$ BEGIN
  IF (SELECT count(*) FROM billing_draft.outbox) <> 1 THEN RAISE EXCEPTION 'Duplicate outbox'; END IF;
  IF EXISTS (SELECT 1 FROM billing_draft.access_periods WHERE activation_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Payment alone activated time';
  END IF;
END $$;
\echo PASS: duplicate receipt rejected, one outbox event, paid access remains unactivated

INSERT INTO billing_draft.payment_entries(attempt_id,order_id,provider,account_key,
  transaction_reference,kind,amount_minor,currency,evidence_reference)
VALUES (1,1,'simulated','fixture-account','second-receipt','collection',1000,'KES','excess-payment');
SELECT pg_temp.expect_error($s$INSERT INTO billing_draft.payment_allocations(order_id,entry_id,amount_minor,currency)
  SELECT 1,id,1000,'KES' FROM billing_draft.payment_entries WHERE transaction_reference='second-receipt'$s$,'23505');
SELECT pg_temp.expect_error($s$INSERT INTO billing_draft.payment_allocations(order_id,entry_id,amount_minor,currency)
  SELECT 999,id,1000,'KES' FROM billing_draft.payment_entries WHERE transaction_reference='second-receipt'$s$,'23503');
SELECT pg_temp.expect_error('UPDATE billing_draft.payment_entries SET amount_minor=2000 WHERE id=1','23514');
SELECT pg_temp.expect_error('DELETE FROM billing_draft.payment_entries WHERE id=1','23514');
\echo PASS: excess payment cannot fund order twice, foreign order rejected, financial history immutable

UPDATE billing_draft.access_periods SET proposed_start_at='2026-10-14T10:00:00Z',
  proposed_expires_at='2026-10-14T11:00:00Z' WHERE id=1;
-- Confirmed never enabled: rescheduling proposed times is permitted.
UPDATE billing_draft.access_periods SET proposed_start_at='2026-10-14T10:10:00Z',
  proposed_expires_at='2026-10-14T11:10:00Z' WHERE id=1;
SELECT pg_temp.expect_error('UPDATE billing_draft.access_periods SET status=''active'' WHERE id=1','23514');
-- Simulated router evidence: these timestamps are not evidence from hardware.
UPDATE billing_draft.access_periods SET activation_at='2026-10-14T10:10:00Z',
  expires_at='2026-10-14T11:10:00Z',status='active' WHERE id=1;
UPDATE billing_draft.access_periods SET activation_at='2026-10-14T10:10:00Z',
  expires_at='2026-10-14T11:10:00Z' WHERE id=1;
SELECT pg_temp.expect_error($s$UPDATE billing_draft.access_periods SET
  activation_at='2026-10-14T10:20:00Z',expires_at='2026-10-14T11:20:00Z' WHERE id=1$s$,'23514');
\echo PASS: proposed timestamps reschedule; active period needs effective times; retry cannot restart clock

UPDATE billing_draft.subscriptions SET status='active',revision=2 WHERE id=1;
DO $$ DECLARE changed integer; BEGIN
  UPDATE billing_draft.subscriptions SET status='expired',revision=revision+1 WHERE id=1 AND revision=1;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'Stale revision changed subscription'; END IF;
END $$;
\echo PASS: stale revision cannot expire renewed subscription state

SELECT pg_temp.expect_error($s$INSERT INTO billing_draft.orders(reference,subscription_id,
  customer_id,hotspot_id,package_id,amount_minor,currency,terms,purchase_mode,payment_deadline)
  SELECT 'replacement-without-consent',subscription_id,customer_id,hotspot_id,package_id,
    amount_minor,currency,terms,'replace_now',now()+interval '15 minutes'
  FROM billing_draft.orders WHERE id=1$s$,'23514');
\echo PASS: immediate replacement requires recorded customer consent

-- A complete worker still has to re-read/lock, reconcile and coordinate actual router actions.
\echo Billing draft checks passed; rolling back all draft objects and fixture rows.
