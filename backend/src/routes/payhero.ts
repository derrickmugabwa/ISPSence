import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import { AccessError, validUuid } from '../modules/billing/accessPolicy';
import { portalSlug } from '../modules/billing/portals';
import { listPayHeroChannels, listPayHeroBanks, registerPayHeroBank } from '../modules/billing/payheroChannels';
import { payHeroSettings, savePayHeroSettings, testPayHeroConnection, initiateAdminPayment, adminPaymentDetail, recheckPayment, receivePayHeroCallback, collectionAvailability, publicCheckout, publicCheckoutStatus, retryPublicCheckout } from '../modules/billing/payhero';
type Handler = (req: Request,res: Response) => Promise<unknown>;
const safe = (fn: Handler) => async (req: Request,res: Response,next: NextFunction) => { try { await fn(req,res); } catch (e) { if (e instanceof AccessError) res.status(e.status).json({ error: e.message,code: (e as AccessError & { code?: string }).code }); else next(e); } };
export const payHeroAdminRoutes = Router();
payHeroAdminRoutes.use(requireAuth,requireAdmin);
payHeroAdminRoutes.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
payHeroAdminRoutes.post(['/channels/list','/banks/list','/channels/bank'],rateLimitRedis({ windowSec: 60,max: 30,keyPrefix: 'payhero-channels' }));
payHeroAdminRoutes.post('/channels/list',safe(async (req,res) => res.json(await listPayHeroChannels(req.body))));
payHeroAdminRoutes.post('/banks/list',safe(async (req,res) => res.json(await listPayHeroBanks(req.body))));
payHeroAdminRoutes.post('/channels/bank',safe(async (req,res) => res.status(200).json(await registerPayHeroBank(req.body,req.user!.username))));
payHeroAdminRoutes.get('/settings',safe(async (_req,res) => res.json(await payHeroSettings())));
payHeroAdminRoutes.put('/settings',safe(async (req,res) => res.json(await savePayHeroSettings(req.body,req.user!.username))));
payHeroAdminRoutes.post('/test',safe(async (_req,res) => res.json(await testPayHeroConnection())));
payHeroAdminRoutes.get('/payments/:id',safe(async (req,res) => { if (!validUuid(req.params.id)) throw new AccessError(400,'Invalid payment'); res.json(await adminPaymentDetail(req.params.id)); }));
payHeroAdminRoutes.post('/payments/:id/collect',safe(async (req,res) => { if (!['sandbox','live'].includes(req.body?.mode)) throw new AccessError(400,'Choose a payment environment'); res.status(202).json(await initiateAdminPayment(req.params.id,req.body?.request_key,req.user!.username,req.body.mode)); }));
payHeroAdminRoutes.post('/attempts/:id/recheck',safe(async (req,res) => { await recheckPayment(req.params.id); res.status(202).json({ queued: true }); }));

// Mounted before ordinary request/audit logging: the per-attempt URL is a bearer secret.
export const payHeroCallbackRoutes = Router();
payHeroCallbackRoutes.use(rateLimitRedis({ windowSec: 60,max: 180,keyPrefix: 'payhero-callback' }),express.json({ limit: '16kb' }));
payHeroCallbackRoutes.post('/:id/:secret',async (req,res) => {
  try { res.json(await receivePayHeroCallback(req.params.id,req.params.secret,req.body)); }
  catch (e) { res.status(e instanceof AccessError ? e.status : 503).json({ error: e instanceof AccessError ? e.message : 'Callback storage unavailable' }); }
});
payHeroCallbackRoutes.use((_req,res) => { res.status(404).json({ error: 'Not found' }); });
payHeroCallbackRoutes.use((_error: unknown,_req: Request,res: Response,_next: NextFunction) => { res.status(400).json({ error: 'Invalid callback body' }); });

export const payHeroPublicRoutes = Router();
payHeroPublicRoutes.use(rateLimitRedis({ windowSec: 60,max: 1200,keyPrefix: 'payhero-public-read',allMethods: true }));
payHeroPublicRoutes.post(/.*/,rateLimitRedis({ windowSec: 60,max: 30,keyPrefix: 'payhero-public-collect' }));
payHeroPublicRoutes.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
payHeroPublicRoutes.get('/availability',safe(async (_req,res) => res.json(await collectionAvailability())));
payHeroPublicRoutes.post('/portals/:slug/checkouts',express.json({ limit: '4kb' }),safe(async (req,res) => res.status(202).json(await publicCheckout(portalSlug(req.params.slug),req.body))));
payHeroPublicRoutes.get('/checkouts/:id',safe(async (req,res) => res.json(await publicCheckoutStatus(req.params.id,req.get('X-Checkout-Token') ?? ''))));
payHeroPublicRoutes.post('/checkouts/:id/retry',safe(async (req,res) => res.status(202).json(await retryPublicCheckout(req.params.id,req.get('X-Checkout-Token') ?? '',req.body?.request_key))));
