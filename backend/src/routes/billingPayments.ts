import { supportsService, validateFundingService } from '../modules/billing/serviceFunding';
import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { query, transaction } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { recordManualReceipt } from '../modules/billing/paymentReceipts';
import { AccessError } from '../modules/billing/accessPolicy';
import { paymentInput, PaymentInput } from '../modules/billing/customersPayments';
import { positiveId } from '../modules/billing/packages';

const router = Router();
router.use(requireAuth, requireAdmin);
router.post('/:id/manual-receipt',async (req,res,next) => {
  try { res.status(200).json(await recordManualReceipt(req.params.id,req.body,req.user!.username)); }
  catch (e) { if (e instanceof AccessError) res.status(e.status).json({ error: e.message }); else next(e); }
});
router.get('/', async (req: Request, res: Response) => {
  const customerId = req.query.customer_id === undefined ? null : positiveId(req.query.customer_id);
  if (req.query.customer_id !== undefined && !customerId) { res.status(400).json({ error: 'Invalid customer filter' }); return; }
  res.json(await query(`SELECT p.*,cs.username AS service_username,cs.label AS service_label,c.full_name AS customer_name,c.phone AS customer_phone,c.customer_code
    FROM billing_purchases p JOIN billing_customers c ON c.id=p.customer_id LEFT JOIN billing_customer_services cs ON cs.id=p.service_id
    ${customerId ? 'WHERE p.customer_id=$1' : ''} ORDER BY p.created_at DESC,p.id`, customerId ? [customerId] : []));
});
router.post('/', async (req: Request, res: Response) => {
  let p: PaymentInput;
  try { p = paymentInput(req.body); } catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  let result;
  try { result = await transaction(async (client) => {
    const existing = await client.query('SELECT * FROM billing_purchases WHERE request_key=$1', [p.request_key]);
    const replay = (record: Record<string, unknown>) => record.customer_id === p.customer_id
      && record.package_id === p.package_id && record.payer_phone === p.payer_phone && (record.service_id ?? null)===(p.service_id ?? null)
      && (record.package_snapshot as Record<string, unknown>).package_version === p.package_version;
    if (existing.rows[0]) return { status: replay(existing.rows[0]) ? 200 : 409, record: existing.rows[0] };
    const customer = await client.query('SELECT id FROM billing_customers WHERE id=$1 FOR KEY SHARE', [p.customer_id]);
    if (!customer.rows[0]) return { status: 404 };
    // Hold a share lock while copying terms so an edit/disable cannot race checkout.
    const offer = await client.query('SELECT * FROM billing_packages WHERE id=$1 FOR SHARE', [p.package_id]);
    const selected = offer.rows[0];
    if (!selected || !selected.enabled) return { status: 422 };
    if (selected.version !== p.package_version) return { status: 412 };
    const serviceType = p.service_id ? 'pppoe' : 'hotspot';
    if (!supportsService(selected,serviceType)) return { status: 423 };
    await validateFundingService(client,p.service_id,p.customer_id);
    const id = randomUUID();
    const snapshot = { fup_policy: selected.fup_policy ?? null, service_type: serviceType,...(p.service_id ? { service_id: p.service_id } : {}),name: selected.name, package_version: selected.version,
      amount_minor: selected.amount_minor, currency: selected.currency,
      duration_value: selected.duration_value,duration_unit: selected.duration_unit,
      download_bps: Number(selected.download_bps),upload_bps: Number(selected.upload_bps),
      allowance_bytes: selected.allowance_bytes === null ? null : Number(selected.allowance_bytes),
      device_limit: 1, timezone: process.env.TZ || 'UTC', start_policy: 'access_ready', calendar_rule: 'clamp_to_last_day' };
    const inserted = await client.query(`INSERT INTO billing_purchases
      (id,reference,request_key,customer_id,package_id,payer_phone,amount_minor,currency,package_snapshot,service_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_key) DO NOTHING RETURNING *`,
    [id,`PAY-${id.replace(/-/g,'').slice(0,12).toUpperCase()}`,p.request_key,p.customer_id,p.package_id,p.payer_phone,
      selected.amount_minor,selected.currency,JSON.stringify(snapshot),p.service_id ?? null]);
    if (inserted.rows[0]) return { status: 201, record: inserted.rows[0] };
    const concurrent = await client.query('SELECT * FROM billing_purchases WHERE request_key=$1', [p.request_key]);
    return { status: replay(concurrent.rows[0]) ? 200 : 409, record: concurrent.rows[0] };
  });
  } catch (error) { if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  if (result.status === 423) { res.status(409).json({ error: 'This package is not available for the selected connection type' }); return; }
  if (result.status === 409) { res.status(409).json({ error: 'This request key belongs to different payment details. Start a new payment.' }); return; }
  if (result.status === 404) { res.status(404).json({ error: 'Customer not found' }); return; }
  if (result.status === 422) { res.status(422).json({ error: 'Choose an enabled package' }); return; }
  if (result.status === 412) { res.status(409).json({ error: 'Package terms changed. Refresh packages and review the new price before saving.' }); return; }
  res.status(result.status).json(result.record);
});
export default router;
