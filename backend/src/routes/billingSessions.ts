import { AccessError } from '../modules/billing/accessPolicy';
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { uuid } from '../modules/billing/subscriptions';
import { positiveId } from '../modules/billing/packages';
import { sessionList, sessionDetail, SessionError } from '../modules/billing/sessions';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/', async (req: Request, res: Response) => {
  const q = req.query.q ?? '', status = req.query.status ?? 'all', rawOffset = req.query.offset ?? '0';
  const customer = req.query.customer_id;
  if (typeof q !== 'string' || q.length>100 || typeof status !== 'string' || !['all','active','ended'].includes(status) ||
    typeof rawOffset !== 'string' || !/^\d{1,7}$/.test(rawOffset) || (customer !== undefined && !positiveId(customer))) {
    res.status(400).json({ error: 'Invalid session search, status or offset' }); return;
  }
  res.json(await sessionList(q.trim(),status,Number(rawOffset),customer === undefined ? undefined : positiveId(customer)!));
});
router.get('/:id', async (req: Request, res: Response) => {
  if (!uuid(req.params.id)) { res.status(400).json({ error: 'Invalid session ID' }); return; }
  try { res.json(await sessionDetail(req.params.id)); }
  catch (e) { if (e instanceof SessionError || e instanceof AccessError) res.status(e.status).json({ error: e.message }); else throw e; }
});
// Session observations are ingested by accounting adapters, never entered as test traffic.
router.post(['/simulation','/:id/simulation'],(_req,res) => {
  res.status(410).json({ error: 'Manual simulation sessions have been removed' });
});
export default router;
