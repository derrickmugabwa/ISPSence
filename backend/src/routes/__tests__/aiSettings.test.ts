import 'express-async-errors';
jest.mock('../../config/database');
jest.mock('../../middleware/rateLimitRedis',()=>({rateLimitRedis:()=> (_req:unknown,_res:unknown,next:()=>void)=>next()}));
jest.mock('../../middleware/auth',()=>({...jest.requireActual('../../middleware/auth'),requireAuth:(req:{user?:unknown},res:{status:(n:number)=>{json:(v:unknown)=>void}},next:()=>void)=>{if(!req.user)res.status(401).json({error:'Sign in required'});else next();}}));
import express from 'express';
import request from 'supertest';
import router from '../aiSettings';
import { query, transaction } from '../../config/database';
import { parseConnection } from '../../modules/ai/settings';
import { checkAiProvider } from '../../modules/ai/providers';
const id='00000000-0000-4000-8000-000000000001';
function app(role?:string,scoped=false){const a=express();a.use(express.json());a.use((req,_res,next)=>{if(role)req.user={userId:1,username:'fixture',role,...(scoped?{siteRoles:{1:role}}:{})};next();});a.use('/ai',router);return a;}
beforeEach(()=>jest.clearAllMocks());
test.each([[undefined,false],['viewer',false],['operator',false],['admin',true]])('AI configuration refuses %s scoped=%s',async(role,scoped)=>{
  const client=request(app(role as string | undefined,scoped as boolean)),status=role?403:401;
  expect((await client.get('/ai')).status).toBe(status);
  expect((await client.post('/ai/connections').send({})).status).toBe(status);
  expect((await client.put('/ai/connections/'+id).send({})).status).toBe(status);
  expect((await client.delete('/ai/connections/'+id).send({})).status).toBe(status);
  expect((await client.put('/ai/defaults').send({})).status).toBe(status);
  expect((await client.post('/ai/connections/'+id+'/test').send({})).status).toBe(status);
  expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
});
const connection={version:0,provider:'deepseek',label:'Fixture',enabled:false,models:['model-a'],api_key:'fictional-test-key'};
test.each([{...connection,base_url:'http://127.0.0.1'},{...connection,api_key:'key\r\nInjected: yes'},{...connection,provider:'custom'},{...connection,models:['<script>']},{...connection,models:Array(51).fill('model')},{...connection,remove_credentials:true},{...connection,label:'bad\nlabel'}])('refuses malformed/unsafe connection input %#',body=>{expect(()=>parseConnection(body)).toThrow();});
test('model lists are normalized without storing a masked secret as a key',()=>{
  expect(parseConnection({...connection,models:['one','one','two'],api_key:''})).toMatchObject({models:['one','two'],api_key:''});
});
test('DeepSeek catalog requests use a fixed HTTPS URL and bearer header',async()=>{
  const transport=jest.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'one'},{id:'one'},{id:'two'},{id:'<invalid>'}]})));
  expect(await checkAiProvider('deepseek','fictional-key',transport)).toEqual({models:['one','two'],truncated:false});
  expect(transport).toHaveBeenCalledWith('https://api.deepseek.com/models',expect.objectContaining({redirect:'error',headers:expect.objectContaining({Authorization:'Bearer fictional-key'})}));
});
test('Gemini uses a secret header and filters non-generation models',async()=>{
  const transport=jest.fn().mockResolvedValue(new Response(JSON.stringify({models:[{name:'models/chat-one',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'more'})));
  expect(await checkAiProvider('google','fictional-key',transport)).toEqual({models:['chat-one'],truncated:true});
  const [url,options]=transport.mock.calls[0];expect(url).not.toContain('fictional-key');expect(options.headers['x-goog-api-key']).toBe('fictional-key');
});
test.each([[401,'authentication_failed'],[403,'permission_denied'],[429,'rate_limited'],[500,'provider_unavailable']])('provider HTTP %s never exposes its body',async(status,code)=>{
  const transport=jest.fn().mockResolvedValue(new Response('secret provider diagnostic',{status:status as number}));
  await expect(checkAiProvider('openai','fictional-key',transport)).rejects.toMatchObject({code});
});
test('invalid and oversized responses fail closed',async()=>{
  await expect(checkAiProvider('deepseek','x',jest.fn().mockResolvedValue(new Response('{invalid')))).rejects.toMatchObject({code:'network_or_response_error'});
  await expect(checkAiProvider('deepseek','x',jest.fn().mockResolvedValue(new Response('x'.repeat(524289))))).rejects.toMatchObject({code:'response_too_large'});
});
test('provider exceptions never return raw credentials or transport errors',async()=>{
  await expect(checkAiProvider('openai','secret',jest.fn().mockRejectedValue(new Error('Authorization: secret')))).rejects.toMatchObject({message:'Provider connection check failed',code:'network_or_response_error'});
});
test('unexpected persistence errors return a sanitized response',async()=>{
  jest.mocked(transaction).mockRejectedValueOnce(new Error('secret SQL parameters'));
  const r=await request(app('admin')).get('/ai');expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('secret SQL');
});
