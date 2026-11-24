import { pipelineDiagnostics,enrollAccountingSource,setAccountingSource } from '../modules/billing/accountingPipeline';
import { AccessError,validUuid } from '../modules/billing/accessPolicy';
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { radiusDiagnostics } from '../modules/billing/radiusAccounting';
const router = Router();
router.use(requireAuth,requireAdmin);
router.get('/pipeline',async(_req,res)=>{res.set('Cache-Control','no-store');res.json(await pipelineDiagnostics());});
router.post('/sources',async(req,res,next)=>{try{res.status(201).json(await enrollAccountingSource(req.body,req.user!.username));}catch(e){if(e instanceof AccessError)res.status(e.status).json({error:e.message});else if((e as {code?:string}).code==='23505')res.status(409).json({error:'Accounting source already enrolled'});else next(e);}});
router.put('/sources/:id/status',async(req,res,next)=>{if(!validUuid(req.params.id)){res.status(400).json({error:'Invalid source ID'});return;}try{res.json(await setAccountingSource(req.params.id,req.body,req.user!.username));}catch(e){if(e instanceof AccessError)res.status(e.status).json({error:e.message});else next(e);}});
router.get('/',async (req: Request,res: Response) => {
  const offset = req.query.offset ?? '0';
  if (typeof offset !== 'string' || !/^\d{1,7}$/.test(offset)) { res.status(400).json({ error: 'Invalid offset' }); return; }
  res.json(await radiusDiagnostics(Number(offset)));
});
export default router;
