import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import { AccessError } from '../modules/billing/accessPolicy';
import { aiSettings, saveAiConnection, deleteAiConnection, saveAiDefaults, testAiConnection } from '../modules/ai/settings';
const router=Router();
router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(requireAuth,requireAdmin);
router.get('/',async (_req,res)=>{res.json(await aiSettings());});
router.post('/connections',async (req,res)=>{res.status(201).json(await saveAiConnection(null,req.body,req.user!.username));});
router.put('/connections/:id',async (req,res)=>{res.json(await saveAiConnection(req.params.id,req.body,req.user!.username));});
router.delete('/connections/:id',async (req,res)=>{res.json(await deleteAiConnection(req.params.id,req.body,req.user!.username));});
router.put('/defaults',async (req,res)=>{res.json(await saveAiDefaults(req.body,req.user!.username));});
router.post('/connections/:id/test',rateLimitRedis({windowSec:60,max:10,keyPrefix:'ai-connection-check'}),async (req,res)=>{res.json(await testAiConnection(req.params.id,req.body,req.user!.username));});
router.use((error: unknown,_req: import('express').Request,res: import('express').Response,_next: import('express').NextFunction)=>{
  // Never pass provider errors/HTTP headers or credential-bearing input onward.
  if (error instanceof AccessError) res.status(error.status).json({error:error.message});
  else res.status(503).json({error:'AI settings are unavailable. Check the database and encryption-key configuration.'});
});
export default router;
