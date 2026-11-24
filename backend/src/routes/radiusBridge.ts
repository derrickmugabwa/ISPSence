import { receiveEnrolledAccounting } from '../modules/billing/accountingPipeline';
import { timingSafeEqual } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { AccessError } from '../modules/billing/accessPolicy';
import { parseRadiusAccounting, receiveRadiusAccounting } from '../modules/billing/radiusAccounting';

const router = Router();
router.use((req: Request,res: Response,next: NextFunction) => {
  res.set('Cache-Control','no-store');
  const expected = process.env.RADIUS_BRIDGE_TOKEN;
  if (!expected || expected.length<64) { res.sendStatus(503); return; }
  const provided = req.get('Authorization');
  const a = Buffer.from(provided ?? ''), b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length || !timingSafeEqual(a,b)) { res.sendStatus(401); return; }
  next();
});
// No production credentials have been issued. A working accounting path is
// not permission to admit a customer or to start purchased time.
router.post('/authorize',(_req: Request,res: Response) => { res.sendStatus(403); });
router.post('/observations',async(req,res,next)=>{try{await receiveEnrolledAccounting(req.body);res.sendStatus(204);}catch(e){if(e instanceof AccessError)res.status(e.status).json({error:e.message});else next(e);}});
router.post('/accounting',async (req: Request,res: Response,next: NextFunction) => {
  try { await receiveRadiusAccounting(parseRadiusAccounting(req.body)); res.sendStatus(204); }
  catch (e) { if (e instanceof AccessError) res.status(e.status).json({ error: e.message }); else next(e); }
});
export default router;
