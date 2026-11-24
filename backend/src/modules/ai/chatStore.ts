import { createHash, randomUUID } from 'crypto';
import { query, transaction } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';
import { AccessError, validUuid } from '../billing/accessPolicy';
import { validModelId, type AiProvider } from './providers';

export interface ChatConversation {id:string;user_id:number;connection_id:string | null;provider:AiProvider;model:string;label:string;retention_days:number;updated_at:Date}
export interface ChatMessage {id:string;role:'user' | 'assistant';content:string}
const publicConversation='id,connection_id,provider,model,label,retention_days,created_at,updated_at';
export function chatTitle(text:string) {
  const normalized=Array.from(text,c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127 ? ' ' : c).join('').replace(/\s+/g,' ').trim();
  const characters=Array.from(normalized);
  return characters.length>80 ? characters.slice(0,77).join('')+'...' : characters.join('') || 'New conversation';
}
async function conversationTitles<T extends {id:string;label:string}>(rows:T[]):Promise<T[]> {
  if(!rows.length)return rows;
  // Derive titles from retained encrypted history; never duplicate message text
  // into the plaintext provider-label column or retain it beyond history policy.
  const first=await query<{conversation_id:string;content_encrypted:string}>(`SELECT DISTINCT ON (m.conversation_id) m.conversation_id,m.content_encrypted
    FROM ai_chat_messages m JOIN ai_conversations c ON c.id=m.conversation_id CROSS JOIN ai_settings s
    WHERE s.id=1 AND m.conversation_id=ANY($1::uuid[]) AND m.role='user' AND c.retention_days>0 AND s.retention_days>0
    AND m.created_at>now()-least(c.retention_days,s.retention_days)*interval '1 day'
    ORDER BY m.conversation_id,m.sequence`,[rows.map(c=>c.id)]);
  const titles=new Map(first.map(m=>[m.conversation_id,chatTitle(decrypt(m.content_encrypted))]));
  return rows.map(c=>({...c,label:titles.get(c.id) ?? 'New conversation'}));
}
export async function purgeAiHistory() {
  await query(`DELETE FROM ai_chat_messages m USING ai_conversations c,ai_settings s WHERE m.conversation_id=c.id AND s.id=1
    AND (c.retention_days=0 OR s.retention_days=0 OR m.created_at<now()-least(c.retention_days,s.retention_days)*interval '1 day')`);
  await query(`DELETE FROM ai_conversations WHERE expires_at<now() AND NOT EXISTS(SELECT 1 FROM ai_chat_runs r WHERE r.conversation_id=ai_conversations.id AND r.state='running' AND r.created_at>now()-interval '90 seconds')`);
  await query("DELETE FROM ai_usage_days WHERE day<(now() AT TIME ZONE 'Africa/Nairobi')::date-90");
}
export function startAiHistorySweep() {
  const sweep=()=>{void purgeAiHistory().catch(()=>console.error('AI history cleanup unavailable'));};sweep();
  const timer=setInterval(sweep,60*60000);timer.unref();
}
export async function listChatConversations(userId:number) {
  await purgeAiHistory();
  return conversationTitles(await query<ChatConversation>(`SELECT ${publicConversation} FROM ai_conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 30`,[userId]));
}
export async function createChatConversation(userId:number,body:unknown) {
  const b=body as Record<string,unknown>;
  if (!b || typeof b!=='object' || Array.isArray(b) || Object.keys(b).some(k=>!['connection_id','model'].includes(k)) || !validUuid(b.connection_id) || !validModelId(b.model)) throw new AccessError(400,'Choose an enabled provider connection and model');
  return transaction(async client=>{
    const settings=(await client.query('SELECT * FROM ai_settings WHERE id=1 FOR SHARE')).rows[0];
    const c=(await client.query('SELECT * FROM ai_connections WHERE id=$1',[b.connection_id])).rows[0];
    if (!c?.enabled || !c.credentials_encrypted || !c.models.includes(b.model)) throw new AccessError(409,'This model is no longer enabled. Choose another model in AI Settings.');
    await client.query('SELECT pg_advisory_xact_lock($1)',[userId]);
    if ((await client.query('SELECT count(*)::int n FROM ai_conversations WHERE user_id=$1',[userId])).rows[0].n>=100) throw new AccessError(429,'Conversation limit reached. Remove old conversations before creating another.');
    return (await client.query(`INSERT INTO ai_conversations(id,user_id,connection_id,provider,model,label,retention_days,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+greatest($7,1)*interval '1 day') RETURNING ${publicConversation}`,[randomUUID(),userId,c.id,c.provider,b.model,'New conversation',settings.retention_days])).rows[0];
  });
}
export async function chatConversation(userId:number,id:string) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid conversation');
  const c=(await query<ChatConversation>(`SELECT ${publicConversation},user_id FROM ai_conversations WHERE id=$1 AND user_id=$2 AND expires_at>now()`,[id,userId]))[0];
  if (!c) throw new AccessError(404,'Conversation not found');return (await conversationTitles([c]))[0];
}
export async function chatMessages(userId:number,id:string):Promise<ChatMessage[]> {
  const c=await chatConversation(userId,id);
  const limits=(await query<{retention_days:number}>('SELECT retention_days FROM ai_settings WHERE id=1'))[0];
  if (!c.retention_days || !limits.retention_days) return [];
  const rows=await query<{id:string;role:'user' | 'assistant';content_encrypted:string}>(`SELECT CASE WHEN m.role='user' THEN r.user_message_id ELSE m.id::text END AS id,m.role,m.content_encrypted FROM (
    SELECT * FROM ai_chat_messages WHERE conversation_id=$1 AND created_at>now()-$2*interval '1 day' ORDER BY sequence DESC LIMIT 20) m JOIN ai_chat_runs r ON r.id=m.run_id ORDER BY m.sequence`,[id,Math.min(c.retention_days,limits.retention_days)]);
  let size=0;const messages:ChatMessage[]=[];
  for (const row of [...rows].reverse()) {const content=decrypt(row.content_encrypted);if(size+content.length>24000)break;size+=content.length;messages.unshift({id:row.id,role:row.role,content});}
  return messages;
}
export function parseChatInput(raw:unknown) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new AccessError(400,'Invalid chat request');
  const b=raw as Record<string,unknown>;
  if (!validUuid(b.threadId) || typeof b.runId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.runId) || !Array.isArray(b.messages) || !b.messages.length || b.messages.length>100) throw new AccessError(400,'Invalid conversation or run');
  // Client history, tools, system messages and forwarded context never become
  // authoritative model input. Only the final user message is accepted.
  const last=b.messages[b.messages.length-1] as Record<string,unknown>;
  if (!last || last.role!=='user' || typeof last.id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(last.id)
    || typeof last.content!=='string' || !last.content.trim() || last.content.length>4000) throw new AccessError(400,'Send a text message of up to 4,000 characters');
  return {threadId:b.threadId,runId:b.runId,messageId:last.id,text:last.content.trim()};
}
export async function beginChatRun(userId:number,input:ReturnType<typeof parseChatInput>) {
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[userId]);
    const settings=(await client.query('SELECT * FROM ai_settings WHERE id=1 FOR SHARE')).rows[0];
    const c=(await client.query<ChatConversation>('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE',[input.threadId,userId])).rows[0];
    if (!c) throw new AccessError(404,'Conversation not found');
    const hash=createHash('sha256').update(input.text).digest('hex');
    const existing=(await client.query('SELECT * FROM ai_chat_runs WHERE conversation_id=$1 AND (client_run_id=$2 OR user_message_id=$3)',[c.id,input.runId,input.messageId])).rows;
    if (existing.length) {
      if (existing.length!==1 || existing[0].input_hash!==hash || existing[0].client_run_id!==input.runId || existing[0].user_message_id!==input.messageId) throw new AccessError(409,'This message was already submitted. Send a new message to retry.');
      throw new AccessError(409,existing[0].state==='running' ? 'This answer is already running.' : 'This message was already processed. Reload the conversation to see saved replies.');
    }
    await client.query("UPDATE ai_chat_runs SET state='interrupted',result_code='lease_expired',finished_at=now() WHERE user_id=$1 AND state='running' AND created_at<now()-interval '90 seconds'",[userId]);
    if ((await client.query("SELECT count(*)::int n FROM ai_chat_runs WHERE user_id=$1 AND state='running'",[userId])).rows[0].n>=2) throw new AccessError(429,'Two answers are already running. Wait or stop one before continuing.');
    if ((await client.query("SELECT id FROM ai_chat_runs WHERE conversation_id=$1 AND state='running'",[c.id])).rows.length) throw new AccessError(409,'This conversation already has an answer running.');
    const connection=c.connection_id ? (await client.query('SELECT * FROM ai_connections WHERE id=$1',[c.connection_id])).rows[0] : null;
    if (!connection?.enabled || !connection.credentials_encrypted || !connection.models.includes(c.model)) throw new AccessError(409,'This conversation model is disabled or unavailable. Start a new conversation with an enabled model.');
    const usage=await client.query(`INSERT INTO ai_usage_days(user_id,day,requests) VALUES($1,(now() AT TIME ZONE 'Africa/Nairobi')::date,1)
      ON CONFLICT(user_id,day) DO UPDATE SET requests=ai_usage_days.requests+1 WHERE ai_usage_days.requests<$2 RETURNING requests`,[userId,settings.requests_per_user_day]);
    if (!usage.rows.length) throw new AccessError(429,'Your daily AI request limit has been reached.');
    const runId=randomUUID(),retain=Math.min(c.retention_days,settings.retention_days);
    await client.query("INSERT INTO ai_chat_runs(id,conversation_id,user_id,client_run_id,user_message_id,input_hash,state) VALUES($1,$2,$3,$4,$5,$6,'running')",[runId,c.id,userId,input.runId,input.messageId,hash]);
    if (retain>0) await client.query("INSERT INTO ai_chat_messages(id,conversation_id,run_id,role,content_encrypted) VALUES($1,$2,$3,'user',$4)",[randomUUID(),c.id,runId,encrypt(input.text)]);
    await client.query("UPDATE ai_conversations SET updated_at=now(),expires_at=now()+greatest($2,1)*interval '1 day' WHERE id=$1",[c.id,retain]);
    return {runId,conversation:c,settings,retain,credentialsEncrypted:connection.credentials_encrypted as string};
  });
}
export async function finishChatRun(runId:string,state:'completed' | 'failed' | 'cancelled',code:string,text:string,inputTokens?:number,outputTokens?:number) {
  await transaction(async client=>{
    const r=(await client.query("SELECT * FROM ai_chat_runs WHERE id=$1 AND state='running' FOR UPDATE",[runId])).rows[0];if(!r)return;
    const c=(await client.query('SELECT c.*,least(c.retention_days,s.retention_days) AS retain FROM ai_conversations c CROSS JOIN ai_settings s WHERE c.id=$1 AND s.id=1',[r.conversation_id])).rows[0];
    const safeToken=(n:unknown)=>Number.isSafeInteger(n) && Number(n)>=0 && Number(n)<2147483647 ? n : null;
    if (state==='completed' && c.retain>0 && text) await client.query("INSERT INTO ai_chat_messages(id,conversation_id,run_id,role,content_encrypted) VALUES($1,$2,$3,'assistant',$4)",[randomUUID(),c.id,runId,encrypt(text)]);
    await client.query('UPDATE ai_chat_runs SET state=$2,result_code=$3,input_tokens=$4,output_tokens=$5,finished_at=now() WHERE id=$1',[runId,state,code,safeToken(inputTokens),safeToken(outputTokens)]);
    await client.query("UPDATE ai_usage_days SET input_tokens=input_tokens+$3,output_tokens=output_tokens+$4 WHERE user_id=$1 AND day=($2::timestamptz AT TIME ZONE 'Africa/Nairobi')::date",[r.user_id,r.created_at,safeToken(inputTokens) ?? 0,safeToken(outputTokens) ?? 0]);
  });
}
export async function chatUsage(userId:number) {
  const row=(await query("SELECT requests,input_tokens::float8,output_tokens::float8 FROM ai_usage_days WHERE user_id=$1 AND day=(now() AT TIME ZONE 'Africa/Nairobi')::date",[userId]))[0];
  return row ?? {requests:0,input_tokens:0,output_tokens:0};
}
export async function removeChatConversation(userId:number,id:string) {
  if(!validUuid(id))throw new AccessError(400,'Invalid conversation');
  await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[userId]);
    const c=(await client.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])).rows[0];
    if(!c)throw new AccessError(404,'Conversation not found');
    if((await client.query("SELECT id FROM ai_chat_runs WHERE conversation_id=$1 AND state='running' AND created_at>now()-interval '90 seconds'",[id])).rows.length)throw new AccessError(409,'Stop the current answer before removing this conversation.');
    await client.query('DELETE FROM ai_conversations WHERE id=$1',[id]);
  });
}
