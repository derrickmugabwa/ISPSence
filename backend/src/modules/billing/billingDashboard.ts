import { transaction } from '../../config/database';
import { AccessError } from './accessPolicy';

export function dashboardInput(q: Record<string,unknown>) {
  const start = String(q.start ?? ''),end = String(q.end ?? ''),mode = 'records',view = String(q.view ?? 'customers');
  const search = String(q.q ?? '').trim(),status = String(q.status ?? 'all'),method = String(q.method ?? 'all');
  const packageId = Number(q.package_id ?? 0),offset = Number(q.offset ?? 0);
  const days = (Date.parse(end)-Date.parse(start))/86400000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isInteger(days) || days<0 || days>92 || new Date(start).toISOString().slice(0,10)!==start || new Date(end).toISOString().slice(0,10)!==end || !['customers','transactions'].includes(view) || search.length>100 || !['all','paid','pending','failed','needs_review','refunded','active','online','offline','unknown','expired','expiry_soon','awaiting_activation','attention','provisioning_failed','paused','vacation','outside_schedule','revoked','no_access','suspended','complimentary'].includes(status) || !['all','payhero','cash','bank_transfer','manual_mpesa','uncollected'].includes(method) || !Number.isInteger(packageId) || packageId<0 || packageId>2147483647 || !Number.isInteger(offset) || offset<0 || offset>1000000) throw new AccessError(400,'Choose valid dashboard dates (up to 93 days), filters and page');
  return { start,end,mode,view,search,status,method,packageId,offset };
}

// Each join has at most one row per purchase/customer; provider retries never multiply money.
export const DASHBOARD_CTES = `WITH bounds AS (
  SELECT ($1::date::timestamp AT TIME ZONE 'Africa/Nairobi') AS start_at,(($2::date+1)::timestamp AT TIME ZONE 'Africa/Nairobi') AS end_at,
  now() AS as_of,$3::text AS scope
), purchase_base AS (
  SELECT p.*,c.full_name AS customer_name,c.phone AS customer_phone,c.customer_code,r.method,r.paid_at,r.recorded_at,r.actor AS received_by,r.notes AS receipt_notes,r.reference AS receipt_reference,
    a.state AS provider_state,a.mode AS provider_mode,a.provider_reference,a.receipt AS provider_receipt,a.last_error,
    CASE WHEN r.id IS NOT NULL OR EXISTS(SELECT 1 FROM billing_payhero_attempts z WHERE z.purchase_id=p.id AND z.mode='live') THEN false
      WHEN EXISTS(SELECT 1 FROM billing_payhero_checkouts x WHERE x.purchase_id=p.id AND x.mode='sandbox') OR a.mode='sandbox'
        OR EXISTS(SELECT 1 FROM billing_subscriptions z WHERE z.purchase_id=p.id AND z.mode='simulation') THEN true ELSE false END AS is_test,
    r.id AS receipt_id
  FROM billing_purchases p JOIN billing_customers c ON c.id=p.customer_id
  LEFT JOIN billing_payment_receipts r ON r.purchase_id=p.id
  LEFT JOIN LATERAL (SELECT z.* FROM billing_payhero_attempts z WHERE z.purchase_id=p.id ORDER BY (z.mode='live') DESC,z.created_at DESC,z.id DESC LIMIT 1) a ON true
), purchases AS (
  SELECT p.*,coalesce(method,CASE WHEN provider_state IS NOT NULL THEN 'payhero' ELSE 'uncollected' END) AS payment_method,
    CASE WHEN NOT is_test THEN CASE WHEN payment_status NOT IN ('paid','refunded') AND provider_state IN ('review','uncertain') THEN 'needs_review' ELSE payment_status END WHEN provider_state='succeeded' THEN 'paid' WHEN provider_state='failed' THEN 'failed' WHEN provider_state IN ('review','uncertain') THEN 'needs_review' ELSE payment_status END AS result,
    coalesce(paid_at,CASE WHEN is_test AND provider_state='succeeded' THEN (SELECT updated_at FROM billing_payhero_attempts z WHERE z.purchase_id=p.id AND z.state='succeeded' ORDER BY updated_at DESC LIMIT 1) END,created_at) AS activity_at
  FROM purchase_base p WHERE ($4::int=0 OR p.package_id=$4)
), access_base AS (
  SELECT s.*,coalesce(p.customer_id,g.customer_id) AS customer_id,coalesce(p.package_id,g.package_id) AS package_id,
    coalesce(p.package_snapshot,g.package_snapshot) AS package_snapshot,coalesce(r.effective_expires_at,s.expires_at) AS effective_expires_at,
    r.frozen_remaining_ms,r.revoked_at,coalesce(r.applied_state,'unknown') AS applied_state,coalesce(ctl.desired_state,'enabled') AS desired_state,
    pol.schedule,a.id AS account_id,coalesce(cs.username,a.username) AS username,a.router_id,a.hotspot_name,CASE WHEN g.id IS NULL THEN 'purchase' ELSE 'complimentary' END AS funding,
    CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' WHEN r.frozen_remaining_ms IS NOT NULL THEN 'paused'
      WHEN s.status='expired' OR (s.status='active' AND coalesce(r.effective_expires_at,s.expires_at)<=b.as_of) THEN 'expired'
      WHEN ctl.desired_state='suspended' THEN 'suspended' WHEN ctl.desired_state='vacation' THEN 'vacation'
      WHEN s.status='active' AND coalesce((pol.schedule->>'enabled')::boolean,false) AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(pol.schedule->'windows') w
        CROSS JOIN LATERAL (SELECT b.as_of AT TIME ZONE (pol.schedule->>'timezone') AS local_now) l
        WHERE CASE WHEN w->>'start'<w->>'end' THEN w->'days' @> to_jsonb(extract(dow FROM l.local_now)::int) AND to_char(l.local_now,'HH24:MI')>=w->>'start' AND to_char(l.local_now,'HH24:MI')<w->>'end'
          ELSE (w->'days' @> to_jsonb(extract(dow FROM l.local_now)::int) AND to_char(l.local_now,'HH24:MI')>=w->>'start') OR (w->'days' @> to_jsonb((extract(dow FROM l.local_now)::int+6)%7) AND to_char(l.local_now,'HH24:MI')<w->>'end') END
      ) THEN 'outside_schedule' WHEN s.status='active' THEN 'active' ELSE s.status END AS access_state
  FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
  LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
  LEFT JOIN billing_customer_controls ctl ON ctl.customer_id=coalesce(p.customer_id,g.customer_id)
  LEFT JOIN billing_access_policy pol ON pol.customer_id=coalesce(p.customer_id,g.customer_id)
  LEFT JOIN billing_access_accounts a ON a.subscription_id=s.id
  LEFT JOIN billing_customer_services cs ON cs.id=coalesce(p.service_id,g.service_id) CROSS JOIN bounds b
), current_access AS (
  SELECT DISTINCT ON(customer_id) * FROM access_base
  ORDER BY customer_id,CASE WHEN revoked_at IS NULL AND (frozen_remaining_ms IS NOT NULL OR (status='active' AND effective_expires_at>(SELECT as_of FROM bounds))) THEN 0 WHEN revoked_at IS NULL AND status='pending_activation' THEN 1 ELSE 2 END,
  effective_expires_at DESC NULLS LAST,created_at DESC,id DESC
), customers AS (
  SELECT c.id,c.full_name,c.customer_code,c.phone,c.created_at,s.id AS subscription_id,s.package_snapshot,s.package_id,s.effective_expires_at AS expires_at,s.frozen_remaining_ms,
    coalesce(s.access_state,'no_access') AS access_state,s.applied_state,s.desired_state,s.schedule,s.funding,s.username,s.router_id,s.hotspot_name,
    p.id AS latest_purchase_id,p.reference,p.result AS payment_status,p.amount_minor,p.payment_method,p.activity_at AS last_payment_at,
    'unknown'::text AS connection,
    coalesce(x.sessions,0)::int AS sessions,x.last_seen,
    (SELECT count(*)::int FROM billing_access_jobs j JOIN access_base ab ON ab.id=j.subscription_id WHERE ab.customer_id=c.id AND j.status='failed') AS failed_jobs
  FROM billing_customers c CROSS JOIN bounds b LEFT JOIN current_access s ON s.customer_id=c.id
  LEFT JOIN LATERAL (SELECT z.* FROM purchases z WHERE z.customer_id=c.id ORDER BY z.activity_at DESC,z.id DESC LIMIT 1) p ON true
  LEFT JOIN LATERAL (SELECT count(*) FILTER(WHERE x.ended_at IS NULL AND ab.access_state='active')::int AS sessions,max(x.updated_at) AS last_seen
    FROM billing_sessions x JOIN access_base ab ON ab.account_id=x.account_id WHERE ab.customer_id=c.id) x ON true
  WHERE ($4::int=0 OR s.package_id=$4 OR (s.id IS NULL AND p.package_id=$4))
    AND ($5::text='all' OR coalesce(p.payment_method,'uncollected')=$5)
)`;

export async function billingDashboard(input: ReturnType<typeof dashboardInput>) {
  const pattern = input.search ? `%${input.search.replace(/[\\%_]/g,'\\$&')}%` : '';
  const params = [input.start,input.end,input.mode,input.packageId,input.method,pattern,input.status,input.offset];
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const totals = (await client.query(`${DASHBOARD_CTES}
      SELECT (SELECT jsonb_build_object(
        'collected_minor',coalesce(sum(amount_minor) FILTER(WHERE NOT is_test AND receipt_id IS NOT NULL AND result='paid' AND paid_at>=b.start_at AND paid_at<b.end_at),0),
        'previous_minor',coalesce(sum(amount_minor) FILTER(WHERE NOT is_test AND receipt_id IS NOT NULL AND result='paid' AND paid_at>=b.start_at-(b.end_at-b.start_at) AND paid_at<b.start_at),0),
        'paid',count(*) FILTER(WHERE result='paid' AND activity_at>=b.start_at AND activity_at<b.end_at),
        'pending',count(*) FILTER(WHERE result='pending' AND activity_at>=b.start_at AND activity_at<b.end_at),
        'failed',count(*) FILTER(WHERE result='failed' AND activity_at>=b.start_at AND activity_at<b.end_at),
        'review',count(*) FILTER(WHERE result='needs_review' OR provider_state IN ('uncertain','review')),
        'refunded',count(*) FILTER(WHERE result='refunded' AND activity_at>=b.start_at AND activity_at<b.end_at),
        'awaiting_activation',count(*) FILTER(WHERE result='paid' AND access_status='awaiting_activation'))
        FROM purchases WHERE ($5::text='all' OR payment_method=$5)) AS money,
      (SELECT jsonb_build_object('total',count(*),'online',count(*) FILTER(WHERE connection='online'),
        'offline',count(*) FILTER(WHERE access_state='active' AND connection='offline'),
        'unknown',count(*) FILTER(WHERE connection='unknown'),'active',count(*) FILTER(WHERE access_state='active'),
        'expired',count(*) FILTER(WHERE access_state='expired'),
        'expiry_soon',count(*) FILTER(WHERE access_state='active' AND expires_at>b.as_of AND expires_at<=b.as_of+interval '24 hours'),
        'paused',count(*) FILTER(WHERE access_state IN ('paused','vacation')),'suspended',count(*) FILTER(WHERE access_state='suspended'),
        'complimentary',count(*) FILTER(WHERE funding='complimentary'),'failed_jobs',coalesce(sum(failed_jobs),0)) FROM customers) AS access,b.as_of
      FROM bounds b`,params.slice(0,5))).rows[0];
    const trend = (await client.query(`${DASHBOARD_CTES}
      SELECT d.day::date::text AS day,coalesce(sum(p.amount_minor) FILTER(WHERE NOT p.is_test AND p.receipt_id IS NOT NULL AND p.result='paid'),0)::float8 AS amount_minor,
        count(p.id) FILTER(WHERE p.result='paid')::int AS paid,count(p.id) FILTER(WHERE p.result='failed')::int AS failed
      FROM generate_series($1::date,$2::date,interval '1 day') d(day) LEFT JOIN purchases p ON (p.activity_at AT TIME ZONE 'Africa/Nairobi')::date=d.day::date AND ($5::text='all' OR p.payment_method=$5)
      GROUP BY d.day ORDER BY d.day`,params.slice(0,5))).rows;
    const breakdown = (await client.query(`${DASHBOARD_CTES} SELECT payment_method,count(*)::int AS transactions,coalesce(sum(amount_minor) FILTER(WHERE NOT is_test AND receipt_id IS NOT NULL AND result='paid'),0)::float8 AS amount_minor
      FROM purchases,bounds b WHERE activity_at>=b.start_at AND activity_at<b.end_at AND ($5::text='all' OR payment_method=$5) GROUP BY payment_method ORDER BY amount_minor DESC,payment_method`,params.slice(0,5))).rows;
    const packages = (await client.query(`${DASHBOARD_CTES} SELECT package_snapshot->>'name' AS name,count(*)::int AS paid,coalesce(sum(amount_minor) FILTER(WHERE NOT is_test AND receipt_id IS NOT NULL),0)::float8 AS amount_minor FROM purchases,bounds b
      WHERE result='paid' AND activity_at>=b.start_at AND activity_at<b.end_at AND ($5::text='all' OR payment_method=$5) GROUP BY package_id,package_snapshot->>'name' ORDER BY paid DESC,name LIMIT 5`,params.slice(0,5))).rows;
    const customerFilter = `WHERE ($6::text='' OR full_name ILIKE $6 OR customer_code ILIKE $6 OR phone ILIKE $6 OR reference ILIKE $6 OR username ILIKE $6)
      AND ($5::text='all' OR payment_method=$5) AND ($7::text='all' OR access_state=$7 OR (connection=$7 AND $7<>'offline') OR ($7='offline' AND connection='offline' AND access_state='active') OR funding=$7
        OR ($7='expiry_soon' AND access_state='active' AND expires_at>now() AND expires_at<=now()+interval '24 hours')
        OR ($7='attention' AND (failed_jobs>0 OR access_state='pending_activation' OR payment_status='needs_review'))
        OR ($7='provisioning_failed' AND failed_jobs>0) OR ($7='paused' AND access_state='vacation')
        OR ($7='awaiting_activation' AND access_state='pending_activation') OR payment_status=$7)`;
    const paymentFilter = `WHERE ($7::text IN ('attention','needs_review','awaiting_activation') OR (activity_at>=b.start_at AND activity_at<b.end_at)) AND ($5::text='all' OR payment_method=$5)
      AND ($6::text='' OR customer_name ILIKE $6 OR customer_code ILIKE $6 OR customer_phone ILIKE $6 OR payer_phone ILIKE $6 OR reference ILIKE $6 OR provider_reference ILIKE $6 OR provider_receipt ILIKE $6 OR receipt_reference ILIKE $6)
      AND ($7::text='all' OR result=$7 OR access_status=$7 OR ($7='attention' AND (result='needs_review' OR provider_state IN ('review','uncertain') OR access_status='awaiting_activation')))`;
    const from = input.view === 'customers' ? `FROM customers ${customerFilter}` : `FROM purchases CROSS JOIN bounds b ${paymentFilter}`;
    const count = (await client.query(`${DASHBOARD_CTES} SELECT count(*)::int AS total ${from}`,params.slice(0,7))).rows[0].total;
    const rows = (await client.query(`${DASHBOARD_CTES} SELECT ${input.view === 'customers' ? '*' : "purchases.*,package_snapshot->>'name' AS package_name,coalesce((SELECT ab.access_state FROM access_base ab WHERE ab.purchase_id=purchases.id ORDER BY ab.created_at DESC LIMIT 1),access_status) AS access_status"} ${from} ORDER BY ${input.view === 'customers' ? 'lower(full_name),id' : 'activity_at DESC,id DESC'} LIMIT 25 OFFSET $8`,params)).rows;
    return { ...totals,trend,breakdown,packages,rows,total: count,offset: input.offset,limit: 25,timezone: 'Africa/Nairobi',mode: input.mode,view: input.view,live_accounting_available: false };
  });
}
