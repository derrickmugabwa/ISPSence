import { Router, type Request, type Response, type NextFunction } from 'express';
import { EventEncoder } from '@ag-ui/encoder';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { validateSession } from '../utils/sessionState';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import { AccessError } from '../modules/billing/accessPolicy';
import { aiSettings } from '../modules/ai/settings';
import { chatConversation, chatMessages, chatUsage, createChatConversation, listChatConversations, parseChatInput, removeChatConversation } from '../modules/ai/chatStore';
import { streamChatRun } from '../modules/ai/chatEngine';

const router=Router();
router.use((_req,res,next)=>{res.set('Cache-Control','no-store, no-transform');next();});
router.use(requireAuth,requireAdmin);
router.use((req,res,next)=>{if(req.user?.tokenAuth){res.status(403).json({error:'Sign in with an administrator session to use the assistant.'});return;}next();});
router.get('/options',async (req,res)=>{
  const s=await aiSettings();
  const connections=s.connections as Array<{id:string;label:string;provider:string;models:string[];enabled:boolean;credentials_configured:boolean}>;
  res.json({default_connection_id:s.default_connection_id,default_model:s.default_model,retention_days:s.retention_days,requests_per_user_day:s.requests_per_user_day,
    connections:connections.filter(c=>c.enabled && c.credentials_configured).map(c=>({id:c.id,label:c.label,provider:c.provider,models:c.models})),usage:await chatUsage(req.user!.userId)});
});
router.get('/conversations',async(req,res)=>{res.json(await listChatConversations(req.user!.userId));});
router.post('/conversations',rateLimitRedis({windowSec:60,max:15,keyPrefix:'ai-new-conversation'}),async(req,res)=>{res.status(201).json(await createChatConversation(req.user!.userId,req.body));});
router.get('/conversations/:id',async(req,res)=>{res.json({conversation:await chatConversation(req.user!.userId,req.params.id),messages:await chatMessages(req.user!.userId,req.params.id)});});
router.delete('/conversations/:id',async(req,res)=>{
  await removeChatConversation(req.user!.userId,req.params.id);
  res.sendStatus(204);
});
router.post('/run',rateLimitRedis({windowSec:60,max:15,keyPrefix:'ai-chat-run'}),async(req,res)=>{
  const input=parseChatInput(req.body),controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]);
  const encoder=new EventEncoder({accept:'text/event-stream'});
  let started=false;
  const close=()=>controller.abort();res.on('close',close);
  const emit=async(event:BaseEvent)=>{
    if(res.destroyed || signal.aborted)return;
    if(!started){res.set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();started=true;}
    if(!res.write(encoder.encode(event)))await new Promise<void>((resolve,reject)=>{
      const done=()=>{res.off('drain',done);signal.removeEventListener('abort',abort);resolve();};
      const abort=()=>{res.off('drain',done);reject(new Error('Stream closed'));};
      res.once('drain',done);signal.addEventListener('abort',abort,{once:true});
    });
  };
  const guard=async()=>{
    const current=await validateSession(req.user!);
    if(!current || current.role!=='admin' || current.siteRoles || current.mustChangePassword)throw new AccessError(403,'Administrator session is no longer authorized');
  };
  const heartbeat=setInterval(()=>{if(started && !res.destroyed)res.write(': heartbeat\n\n');},10000);
  try {await streamChatRun(req.user!.userId,input,signal,guard,emit);}
  catch(error) {
    if(!started && error instanceof AccessError){res.status(error.status).json({error:error.message});return;}
    if(!res.destroyed){if(!started){res.set('Content-Type','text/event-stream');started=true;}res.write(encoder.encode({type:EventType.RUN_ERROR,message:error instanceof AccessError ? error.message : signal.aborted ? 'Response stopped or timed out.' : 'Unable to complete this answer. Check the model and provider in AI Settings.'}));}
  } finally {clearInterval(heartbeat);res.off('close',close);if(!res.writableEnded)res.end();}
});
router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{res.status(error instanceof AccessError ? error.status : 503).json({error:error instanceof AccessError ? error.message : 'The AI assistant is unavailable. Check settings and try again.'});});
export default router;
