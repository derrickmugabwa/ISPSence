import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { query } from '../config/database';
import { positiveId } from '../modules/billing/packages';
import { AccessError, validUuid } from '../modules/billing/accessPolicy';
import { accessManagementView, registerDevice, changeDevice, saveAccessPolicy, controlCustomer, revokeComplimentary, disconnectSessions, queueRenewal } from '../modules/billing/accessManagement';

const router = Router();
router.use(requireAuth,requireAdmin);
type Handler = (req: Request, res: Response) => Promise<unknown>;
const safe = (handler: Handler) => async (req: Request,res: Response,next: NextFunction) => {
  try { await handler(req,res); } catch (e) {
    if (e instanceof AccessError) res.status(e.status).json({ error: e.message });
    else if ((e as { code?: string }).code === '23505') res.status(409).json({ error: 'This device or renewal is already registered. Refresh the customer.' });
    else next(e);
  }
};
router.get('/alerts',safe(async (_req,res) => res.json(await query(`SELECT a.*,s.mode,c.full_name AS customer_name FROM billing_access_alerts a
  JOIN billing_customers c ON c.id=a.customer_id LEFT JOIN billing_subscriptions s ON s.id=a.subscription_id WHERE a.resolved_at IS NULL ORDER BY a.created_at DESC,a.id LIMIT 200`))));
router.post('/alerts/:alert/read',safe(async (req,res) => {
  if (!validUuid(req.params.alert)) throw new AccessError(400,'Invalid alert');
  const rows = await query('UPDATE billing_access_alerts SET read_at=coalesce(read_at,clock_timestamp()) WHERE id=$1 RETURNING *',[req.params.alert]);
  if (!rows.length) throw new AccessError(404,'Alert not found');
  res.json(rows[0]);
}));
const customer = (req: Request) => { const id = positiveId(req.params.id); if (!id) throw new AccessError(400,'Invalid customer'); return id; };
router.get('/customers/:id',safe(async (req,res) => res.json(await accessManagementView(customer(req)))));
router.post('/customers/:id/devices',safe(async (req,res) => res.json(await registerDevice(customer(req),req.body,req.user!.username))));
router.put('/customers/:id/devices/:device',safe(async (req,res) => res.json(await changeDevice(customer(req),req.params.device,req.body,req.user!.username))));
router.put('/customers/:id/policy',safe(async (req,res) => res.json(await saveAccessPolicy(customer(req),req.body,req.user!.username))));
router.post('/customers/:id/control',safe(async (req,res) => res.json(await controlCustomer(customer(req),req.body,req.user!.username))));
router.post('/customers/:id/revoke/:subscription',safe(async (req,res) => res.json(await revokeComplimentary(customer(req),req.params.subscription,req.body,req.user!.username))));
router.post('/customers/:id/disconnect',safe(async (req,res) => res.json(await disconnectSessions(customer(req),req.body,req.user!.username))));
router.post('/customers/:id/renewal',safe(async (req,res) => res.json(await queueRenewal(customer(req),req.body,req.user!.username))));
export default router;
