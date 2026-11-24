// Loopback-only visual QA. Fictional auth/config; no DB or provider connection.
const {createServer}=require('node:http');
const {readFile}=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=path.resolve('.local/ai-ui-dist');
const user={id:1,username:'ui-fixture',role:'admin',must_change_password:false};
const providers=[{id:'deepseek',name:'DeepSeek',origin:'https://api.deepseek.com'},{id:'openai',name:'OpenAI',origin:'https://api.openai.com'},{id:'google',name:'Google Gemini',origin:'https://generativelanguage.googleapis.com'}];
let config={version:1,default_connection_id:null,default_model:null,requests_per_user_day:50,max_output_tokens:4096,max_tool_steps:5,retention_days:30,connection_checks_today:0,assistant_available:false,providers,connections:[]};
const conversations=[],messages=new Map();let requests=0;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname==='/__fixture/stop'){send(200,{stopped:true});server.close();return;}
  if(url.pathname==='/__fixture/metrics')return send(200,{requests,conversations:conversations.length});
  if(url.pathname==='/__fixture/chat'){
    const id=randomUUID();config.connections=[{id,provider:'openai',label:'Fictional operations',enabled:true,models:['fixture-chat'],credentials_configured:true,available_models:[],version:1}];config.default_connection_id=id;config.default_model='fixture-chat';return send(200,{ready:true});
  }
  if(url.pathname==='/__fixture/long'){
    const connection=config.connections[0];if(!connection)return send(400,{error:'Seed chat first'});
    const c={id:randomUUID(),connection_id:connection.id,provider:connection.provider,label:'Customer access review',model:'fixture-chat',retention_days:30,updated_at:new Date().toISOString()};
    const answer=`Here is the access review for **Example Customer**. These are fictional records used to check the chat layout.

## Access summary
The customer has an **active purchased period** and an enabled access account. The requested policy allows one connection, with the speed inherited from the selected package.

The field \`live_accounting_available\` is false. These records describe the intended service; they do not establish whether the customer is online right now.

### What the records confirm
- **Payment:** the latest fictional payment is recorded as successful.
- **Entitlement:** the purchased period has not expired.
- **Account:** access is enabled and no vacation pause is requested.
- **Speed policy:** the customer uses the package defaults.
- **Devices:** one registered device is within the connection limit.

### What still needs checking
There is no current router session in this fictional response. An enabled account does not prove that authentication succeeded, a device received an address, or traffic can reach the internet. Treat current connectivity as unknown until a recent session or router observation is available.

Check the most recent provisioning attempt and compare its confirmed policy with the requested policy. A pending attempt means the application is still waiting for confirmation. A failed attempt should include the reason and a safe retry action. If the router result is uncertain, reconcile the existing state before sending another change.

### Suggested next steps
1. Open the customer's access account and confirm the account identifier.
2. Review provisioning status and its last confirmed update.
3. Look for a recent session and its disconnect reason.
4. Check whether a schedule or pause currently restricts access.

If the account is eligible but authentication fails, inspect the authentication result before changing the package or recording another payment. If authentication succeeds but browsing fails, inspect address assignment and upstream reachability.

No changes were made. This review only reads fictional records.`;
    const formatted=answer+'\n\n### Diagnostic example\n\n> Session visibility is unavailable. Confirm connectivity before reporting a customer as online.\n\n```json\n{\n  "access": "enabled",\n  "live_accounting_available": false\n}\n```\n\nReview the [customer details](/billing/customers/1) for the latest saved policy.';
    conversations.unshift(c);messages.set(c.id,[{id:randomUUID(),role:'user',content:'Review Example Customer and explain what could prevent internet access.'},{id:randomUUID(),role:'assistant',content:formatted}]);
    config.default_connection_id=null;config.default_model=null;return send(200,{ready:true});
  }
  if(url.pathname==='/api/ai/chat/options')return send(200,{...config,usage:{requests,input_tokens:requests*20,output_tokens:requests*10}});
  if(url.pathname.startsWith('/api/ai/chat/')){
    let text='';for await(const chunk of req){text+=chunk;if(text.length>131072)return send(413,{error:'Too large'});}
    let body={};try{body=JSON.parse(text||'{}');}catch{return send(400,{error:'Invalid JSON'});}
    if(url.pathname.endsWith('/run')){
      requests++;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
      const emit=e=>res.write(`data: ${JSON.stringify(e)}\n\n`),messageId=randomUUID();
      const answer='Confirmed: this is a fictional browser test. Live customer connectivity is unknown. Review [customer details](/billing/customers/1).';
      const current=body.messages.at(-1),saved=messages.get(body.threadId)||[];
      if(!saved.length){const c=conversations.find(c=>c.id===body.threadId);if(c)c.label=current.content.replace(/\s+/g,' ').trim().slice(0,80);}
      messages.set(body.threadId,[...saved,current]);
      emit({type:'RUN_STARTED',threadId:body.threadId,runId:body.runId});emit({type:'TEXT_MESSAGE_START',messageId,role:'assistant'});
      if(current.content.includes('failure')){emit({type:'RUN_ERROR',message:'Fictional provider unavailable'});res.end();return;}
      emit({type:'TOOL_CALL_START',toolCallId:'fixture-check-'+requests,toolCallName:'getRouterStatus',parentMessageId:messageId});
      emit({type:'TOOL_CALL_ARGS',toolCallId:'fixture-check-'+requests,delta:JSON.stringify({search:'Fictional'})});emit({type:'TOOL_CALL_END',toolCallId:'fixture-check-'+requests});
      emit({type:'TOOL_CALL_RESULT',toolCallId:'fixture-check-'+requests,messageId:randomUUID(),role:'tool',content:JSON.stringify({ok:true,data:{name:'Fictional router',status:'unknown'}})});
      for(const word of answer.split(' ')){if(res.destroyed)break;emit({type:'TEXT_MESSAGE_CONTENT',messageId,delta:word+' '});await new Promise(r=>setTimeout(r,current.content.includes('slow')?500:35));}
      if(!res.destroyed){messages.set(body.threadId,[...messages.get(body.threadId),{id:messageId,role:'assistant',content:answer}]);emit({type:'TEXT_MESSAGE_END',messageId});emit({type:'RUN_FINISHED',threadId:body.threadId,runId:body.runId});res.end();}return;
    }
    if(url.pathname==='/api/ai/chat/conversations'){
      if(req.method==='GET')return send(200,conversations);
      const c={id:randomUUID(),connection_id:body.connection_id,provider:'openai',label:'New conversation',model:body.model,retention_days:30,updated_at:new Date().toISOString()};conversations.unshift(c);messages.set(c.id,[]);return send(201,c);
    }
    const id=url.pathname.split('/').at(-1),c=conversations.find(c=>c.id===id);
    if(!c)return send(404,{error:'Conversation not found'});
    if(req.method==='DELETE'){conversations.splice(conversations.indexOf(c),1);messages.delete(id);res.writeHead(204);res.end();return;}
    return send(200,{conversation:c,messages:messages.get(id)});
  }
  if(url.pathname==='/api/auth/me')return send(200,user);
  if(url.pathname==='/api/auth/security-status')return send(200,{warnings:[]});
  if(url.pathname==='/api/settings')return send(200,{});
  if(url.pathname==='/api/ai/settings' && req.method==='GET')return send(200,config);
  if(url.pathname.startsWith('/api/ai/settings')){
    let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)return send(413,{error:'Too large'});}
    let body={};try{body=JSON.parse(text||'{}');}catch{return send(400,{error:'Invalid JSON'});}
    const id=url.pathname.split('/')[5],connection=config.connections.find(c=>c.id===id);
    if(url.pathname.endsWith('/test')){if(!connection)return send(404,{error:'Not found'});connection.last_test_at=new Date().toISOString();connection.last_test_code='connected';connection.available_models=['fixture-chat','fixture-reasoning'];config.connection_checks_today++;return send(200,{connected:true,code:'connected',models:connection.available_models,truncated:false});}
    if(body.version!==config.version)return send(409,{error:'AI settings changed. Reload before saving.'});
    if(url.pathname.endsWith('/defaults'))Object.assign(config,{default_connection_id:body.default_connection_id,default_model:body.default_model,requests_per_user_day:body.requests_per_user_day,max_output_tokens:body.max_output_tokens,max_tool_steps:body.max_tool_steps,retention_days:body.retention_days});
    else if(req.method==='DELETE'){config.connections=config.connections.filter(c=>c.id!==id);if(config.default_connection_id===id){config.default_connection_id=null;config.default_model=null;}}
    else {
      const next={id:connection?.id??randomUUID(),provider:body.provider,label:body.label,enabled:body.enabled,models:body.models,credentials_configured:body.remove_credentials?false:Boolean(body.api_key)||Boolean(connection?.credentials_configured),version:(connection?.version??0)+1,last_test_at:null,last_test_code:null,available_models:connection?.available_models??[]};
      config.connections=connection?config.connections.map(c=>c.id===id?next:c):[...config.connections,next];
    }
    config.version++;return send(200,config);
  }
  if(url.pathname==='/api/billing/customers/1/fup')return send(200,{setting:{mode:'inherit',policy:null,expires_at:null,version:0},effective_mode:'inherit',enforcement:'awaiting_production_accounting',periods:[]});
  if(url.pathname==='/api/billing/customers/1/profile')return send(200,{});
  if(url.pathname==='/api/billing/radius/pipeline')return send(200,{accounting:{received:0,pending:0,attention:0,last_received_at:null},provisioning:[{state:'waiting_adapter',total:2}],sources:[],health:[{name:'billing',last_succeeded_at:new Date().toISOString(),last_code:null}],sessions:{total:0,unmapped:0,stale:0},authorization_enabled:false});
  if(url.pathname==='/api/billing/radius')return send(200,{configured:false,mode:'private_lab',live_authorization:false,summary:{packet_count:0,last_received_at:null},records:[],total:0,offset:0,limit:50});
  if(url.pathname==='/api/billing/sessions') return send(200,{items:[],summary:{total:0,active:0,download_bytes:0,upload_bytes:0},offset:0,limit:50});
  if(url.pathname==='/api/billing/dashboard') return send(200,{money:{collected_minor:120000,previous_minor:90000,paid:4,pending:2,failed:0,review:0,refunded:0,awaiting_activation:1},access:{total:6,online:0,offline:0,unknown:6,active:2,expired:1,expiry_soon:0,paused:0,suspended:0,complimentary:0,failed_jobs:0},rows:[],total:0,offset:0,limit:25,as_of:new Date().toISOString(),timezone:'Africa/Nairobi',view:url.searchParams.get('view')||'customers',live_accounting_available:false,trend:[],breakdown:[],packages:[]});
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io'))return send(200,[]);
  try{
    let target=path.resolve(root,'.'+url.pathname);if(!target.startsWith(root+path.sep))target=path.join(root,'index.html');
    let bytes;try{bytes=await readFile(target);}catch{target=path.join(root,'index.html');bytes=await readFile(target);}
    const ext=path.extname(target);if(ext==='.html'){
      const theme=url.searchParams.get('theme')==='dark'?'dark':'light';
      const authSeed=url.pathname==='/login' ? "localStorage.removeItem('mikrotik-auth');" : `localStorage.setItem('mikrotik-auth',JSON.stringify({state:{token:'fictional-ui-session',user:${JSON.stringify(user)},isAuthenticated:true},version:0}));`;
      const seed=`<script>${authSeed}localStorage.setItem('mikrotik-theme',JSON.stringify({state:{theme:'${theme}'},version:0}));</script>`;
      bytes=Buffer.from(bytes.toString().replace('<head>','<head>'+seed));
    }
    res.writeHead(200,{'Content-Type':ext==='.js'?'text/javascript':ext==='.css'?'text/css':ext==='.html'?'text/html':ext==='.svg'?'image/svg+xml':'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  }catch{send(500,{error:'Build artifacts unavailable'});}
});
server.listen(8790,'127.0.0.1',()=>console.log('AI Settings visual fixture ready on loopback 8790; fictional data only'));
setTimeout(()=>server.close(),20*60000).unref();
