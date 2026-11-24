import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { AccessError } from '../modules/billing/accessPolicy';
import { positiveId } from '../modules/billing/packages';
import { portalTemplates, portalList, portalDetail, createPortal, savePortal, publishPortal, parsePortalCreate, parsePortalSave, parsePortalVersion, publicPortal } from '../modules/billing/portals';
const router = Router();
type Handler = (req: Request,res: Response) => Promise<unknown>;
const safe = (handler: Handler) => async (req: Request,res: Response,next: NextFunction) => {
  try { await handler(req,res); }
  catch (e) {
    if (e instanceof AccessError) res.status(e.status).json({ error: e.message });
    else if ((e as { code?: string }).code === '23505') res.status(409).json({ error: 'That portal URL is already in use' });
    else next(e);
  }
};
const id = (req: Request) => { const value = positiveId(req.params.id); if (!value) throw new AccessError(400,'Invalid portal'); return value; };
router.use(requireAuth,requireAdmin);
router.get('/templates',(_req: Request,res: Response) => { res.json(portalTemplates); });
router.get('/',safe(async (_req,res) => res.json(await portalList())));
router.get('/:id',safe(async (req,res) => res.json(await portalDetail(id(req)))));
router.post('/',safe(async (req,res) => res.status(201).json(await createPortal(parsePortalCreate(req.body),req.user!.username))));
router.put('/:id',safe(async (req,res) => res.json(await savePortal(id(req),parsePortalSave(req.body),req.user!.username))));
router.post('/:id/publish',safe(async (req,res) => res.json(await publishPortal(id(req),parsePortalVersion(req.body),true,req.user!.username))));
router.post('/:id/unpublish',safe(async (req,res) => res.json(await publishPortal(id(req),parsePortalVersion(req.body),false,req.user!.username))));
export const publicPortalRoutes = Router();
publicPortalRoutes.use((_req: Request,res: Response,next: NextFunction) => { res.set('Cache-Control','no-store'); next(); });
publicPortalRoutes.get('/:slug',safe(async (req,res) => res.json(await publicPortal(req.params.slug))));
export default router;
