import { linkPreparedService } from '../modules/billing/serviceFunding';
import { AccessError } from '../modules/billing/accessPolicy';
import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { transaction } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { subscriptionList, uuid } from '../modules/billing/subscriptions';
import { positiveId } from '../modules/billing/packages';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/', async (req: Request, res: Response) => {
  const customer = req.query.customer_id;
  if (customer !== undefined && !positiveId(customer)) { res.status(400).json({ error: 'Invalid customer filter' }); return; }
  res.json(await subscriptionList(customer === undefined ? undefined : positiveId(customer)!));
});
router.post('/', async (req: Request, res: Response) => {
  const { purchase_id: purchaseId, mode = 'live' } = req.body ?? {};
  if (!uuid(purchaseId) || mode !== 'live') {
    res.status(400).json({ error: 'Choose a payment record for the subscription' }); return;
  }
  let result;
  try { result = await transaction(async (client) => {
    const purchase = await client.query('SELECT id,payment_status,customer_id,service_id FROM billing_purchases WHERE id=$1 FOR KEY SHARE', [purchaseId]);
    if (!purchase.rows[0]) return null;
    if (purchase.rows[0].service_id && purchase.rows[0].payment_status!=='paid') throw new AccessError(409,'Confirm payment before preparing PPPoE access');
    if (purchase.rows[0].service_id && mode!=='live') throw new AccessError(409,'PPPoE connections cannot be used for simulation access');
    const id = randomUUID();
    const status = purchase.rows[0].payment_status === 'paid' ? 'pending_activation' : 'awaiting_payment';
    const inserted = await client.query(`INSERT INTO billing_subscriptions(id,purchase_id,mode,status)
      VALUES($1,$2,$3,$4) ON CONFLICT(purchase_id,mode) DO NOTHING RETURNING *`, [id,purchaseId,mode,status]);
    const row = inserted.rows[0] ?? (await client.query('SELECT * FROM billing_subscriptions WHERE purchase_id=$1 AND mode=$2', [purchaseId,mode])).rows[0];
    if (inserted.rows[0]) await client.query(`INSERT INTO billing_access_accounts(id,subscription_id,username)
      VALUES($1,$2,$3)`, [randomUUID(),row.id,`${mode === 'simulation' ? 'sim' : 'acct'}_${row.id.replace(/-/g,'')}`]);
    if (inserted.rows[0]) await client.query(`INSERT INTO billing_access_events(subscription_id,kind,actor)
      VALUES($1,'prepared',$2)`, [row.id,req.user!.username]);
    await linkPreparedService(client,row.id,purchase.rows[0].service_id);
    return { row, created: !!inserted.rows[0] };
  });
  } catch (error) { if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  if (!result) { res.status(404).json({ error: 'Payment record not found' }); return; }
  res.status(result.created ? 201 : 200).json(result.row);
});
router.post('/:id/activate-simulation', (_req,res) => { res.status(410).json({ error: 'Manual simulation activation has been removed' }); });
export default router;
