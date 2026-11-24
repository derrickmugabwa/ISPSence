import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { AccessError } from '../modules/billing/accessPolicy';
import { positiveId } from '../modules/billing/packages';
import { createServiceDraft, listCustomerServices, parseServiceDraft } from '../modules/billing/customerServices';
import { generateServiceCredentials, parseCredentialInput } from '../modules/billing/serviceCredentials';
import { bindingRouters, discoverServiceRouter, parseBindingInput, parseDiscoveryInput, saveServiceBinding } from '../modules/billing/serviceBindings';

const router = Router();
// Also set on errors/refusals: no credential response may be cached.
router.use((_req: Request,res: Response,next) => { res.set('Cache-Control','no-store'); res.set('Pragma','no-cache'); next(); });
router.use(requireAuth,requireAdmin);
router.get('/routers',async (_req: Request,res: Response) => { res.json(await bindingRouters()); });
router.post('/:id/discover',async (req: Request,res: Response) => {
  try { res.json(await discoverServiceRouter(req.params.id,parseDiscoveryInput(req.body))); }
  catch (error) { if (error instanceof AccessError) res.status(error.status).json({ error: error.message }); else throw error; }
});
router.post('/:id/binding',async (req: Request,res: Response) => {
  try { res.json(await saveServiceBinding(req.params.id,parseBindingInput(req.body),req.user!.username)); }
  catch (error) { if (error instanceof AccessError) res.status(error.status).json({ error: error.message }); else throw error; }
});
router.get('/',async (req: Request,res: Response) => {
  const customerId = positiveId(req.query.customer_id);
  if (!customerId) { res.status(400).json({ error: 'Select a valid customer' }); return; }
  res.json(await listCustomerServices(customerId));
});
router.post('/',async (req: Request,res: Response) => {
  try {
    const result = await createServiceDraft(parseServiceDraft(req.body),req.user!.username);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof AccessError) res.status(error.status).json({ error: error.message }); else throw error;
  }
});
router.post('/:id/credentials',async (req: Request,res: Response) => {
  try {
    res.json(await generateServiceCredentials(req.params.id,parseCredentialInput(req.body),req.user!.username));
  } catch (error) {
    if (error instanceof AccessError) res.status(error.status).json({ error: error.message }); else throw error;
  }
});
export default router;
