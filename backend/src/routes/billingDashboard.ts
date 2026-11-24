import { Router } from 'express';
import { requireAuth,requireAdmin } from '../middleware/auth';
import { billingDashboard,dashboardInput } from '../modules/billing/billingDashboard';
import { AccessError } from '../modules/billing/accessPolicy';
const router = Router();
router.use(requireAuth,requireAdmin);
router.get('/',async (req,res,next) => {
  res.setHeader('Cache-Control','no-store');
  try { res.json(await billingDashboard(dashboardInput(req.query))); }
  catch (e) { if (e instanceof AccessError) res.status(e.status).json({ error: e.message }); else next(e); }
});
export default router;
