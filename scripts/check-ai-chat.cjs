// Disposable PostgreSQL checks; no provider requests or production customer data.
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {Pool}=require('pg');
async function main(){
  const schema='ai_chat_lab_'+randomUUID().replace(/-/g,'');
  process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.SECRETS_DIR='/tmp/'+schema;
  const url=new URL(process.env.DATABASE_URL);if(process.env.DB_PASSWORD)url.password=encodeURIComponent(process.env.DB_PASSWORD);
  const control=new Pool({connectionString:url.toString(),options:'-c search_path=public'});let pool;
  try{
    await control.query('CREATE SCHEMA "'+schema+'"');process.env.PGOPTIONS='-c search_path='+schema;
    ({pool}=require('/app/dist/config/database'));
    await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2)');
    await pool.query(require('/app/dist/modules/ai/schema').AI_SETTINGS_SCHEMA);
    const sql=require('/app/dist/modules/ai/chatSchema').AI_CHAT_SCHEMA;await pool.query(sql);await pool.query(sql);
    const settings=require('/app/dist/modules/ai/settings'),chat=require('/app/dist/modules/ai/chatStore');
    const cfg=await settings.saveAiConnection(null,{version:0,provider:'openai',label:'Fictional operations',enabled:true,models:['fixture-model'],api_key:'fictional-key'},'fixture');
    const connection_id=cfg.connections[0].id;
    const create=()=>chat.createChatConversation(1,{connection_id,model:'fixture-model'});
    const input=(c,text='Inspect fictional customer')=>({threadId:c.id,runId:randomUUID(),messageId:randomUUID(),text});
    const c=await create();assert.equal(c.label,'New conversation');await assert.rejects(chat.chatConversation(2,c.id),e=>e.status===404);
    const first=input(c),second=input(c);const race=await Promise.allSettled([chat.beginChatRun(1,first),chat.beginChatRun(1,second)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    const run=race.find(r=>r.status==='fulfilled').value;
    await assert.rejects(chat.removeChatConversation(1,c.id),e=>e.status===409);
    await chat.finishChatRun(run.runId,'completed','completed','Fictional answer',12,7);
    const saved=await chat.chatMessages(1,c.id);assert.equal(saved.length,2);assert.equal(saved[1].content,'Fictional answer');
    await pool.query('UPDATE ai_conversations SET label=$2 WHERE id=$1',[c.id,'Legacy provider label']);
    assert.equal((await chat.listChatConversations(1)).find(row=>row.id===c.id).label,first.text);
    assert.equal((await chat.chatConversation(1,c.id)).label,first.text);
    assert.equal((await pool.query('SELECT label FROM ai_conversations WHERE id=$1',[c.id])).rows[0].label,'Legacy provider label');
    const raw=JSON.stringify((await pool.query('SELECT content_encrypted FROM ai_chat_messages')).rows);assert.ok(!raw.includes('Fictional answer'));assert.ok(!raw.includes(first.text));
    await assert.rejects(chat.beginChatRun(1,race[0].status==='fulfilled'?first:second),e=>e.status===409);
    assert.equal((await chat.chatUsage(1)).requests,1);assert.equal((await chat.chatUsage(1)).output_tokens,7);
    await pool.query('UPDATE ai_settings SET requests_per_user_day=2');
    const next=await chat.beginChatRun(1,input(c));await chat.finishChatRun(next.runId,'cancelled','cancelled','');
    await assert.rejects(chat.beginChatRun(1,input(await create())),e=>e.status===429);
    await assert.rejects(chat.beginChatRun(2,input(c)),e=>e.status===404);
    await pool.query('UPDATE ai_settings SET requests_per_user_day=10,retention_days=0');
    assert.deepEqual(await chat.chatMessages(1,c.id),[]);await chat.purgeAiHistory();
    assert.equal((await chat.listChatConversations(1)).find(row=>row.id===c.id).label,'New conversation');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai_chat_messages')).rows[0].n,0);
    const zero=await chat.beginChatRun(1,input(c));await chat.finishChatRun(zero.runId,'completed','completed','Never persist this answer');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai_chat_messages')).rows[0].n,0);
    await chat.removeChatConversation(1,c.id);await assert.rejects(chat.chatConversation(1,c.id),e=>e.status===404);
    console.log('PASS: repeatable chat schema, ownership, concurrent-run exclusion, encrypted history, idempotency, daily reservations, cancellation accounting, zero retention and deletion');
  }finally{if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await control.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
