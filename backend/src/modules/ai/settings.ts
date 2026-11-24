import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';
import { AccessError, validUuid, versionNumber } from '../billing/accessPolicy';
import { AI_PROVIDERS, AiProviderError, checkAiProvider, validModelId, type AiProvider, type AiTransport } from './providers';

function object(value: unknown,keys: string[]) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) throw new AccessError(400,'Invalid AI settings fields');
  return value as Record<string,unknown>;
}
const publicColumns='id,provider,label,enabled,models,version,last_test_at,last_test_code,available_models,created_at,updated_at,(credentials_encrypted IS NOT NULL) AS credentials_configured';
export async function aiSettings() {
  return transaction(async client=>{
    // All configuration mutations acquire this same singleton lock.
    const settings=(await client.query('SELECT * FROM ai_settings WHERE id=1 FOR SHARE')).rows[0];
    const connections=(await client.query(`SELECT ${publicColumns} FROM ai_connections ORDER BY created_at,id`)).rows;
    const checks=(await client.query("SELECT count(*)::int AS n FROM ai_settings_events WHERE kind='connection_tested' AND created_at>=(date_trunc('day',now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi')")).rows[0].n;
    return {...settings,connections,providers:AI_PROVIDERS,connection_checks_today:checks,assistant_available:true};
  });
}
async function lockSettings(client: PoolClient,version: unknown) {
  const expected=versionNumber(version),settings=(await client.query('SELECT * FROM ai_settings WHERE id=1 FOR UPDATE')).rows[0];
  if (settings.version!==expected) throw new AccessError(409,'AI settings changed. Reload before saving.');
  return settings;
}
async function event(client: PoolClient,id: string | null,kind: string,actor: string,detail: unknown={}) {
  await client.query('INSERT INTO ai_settings_events(connection_id,kind,actor,detail) VALUES($1,$2,$3,$4)',[id,kind,actor,JSON.stringify(detail)]);
}
export function parseConnection(body: unknown) {
  const b=object(body,['version','provider','label','enabled','models','api_key','remove_credentials']);
  versionNumber(b.version);
  if (!AI_PROVIDERS.some(p=>p.id===b.provider) || typeof b.label!=='string' || !b.label.trim() || b.label.trim().length>80 || Array.from(b.label).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)
    || typeof b.enabled!=='boolean' || !Array.isArray(b.models) || b.models.length>50 || b.models.some(m=>!validModelId(m))
    || b.remove_credentials!==undefined && typeof b.remove_credentials!=='boolean') throw new AccessError(400,'Choose a provider, name and up to 50 valid model IDs');
  if (b.api_key!==undefined && (typeof b.api_key!=='string' || b.api_key.length>4096 || /[^\x21-\x7e]/.test(b.api_key))) throw new AccessError(400,'Enter an API key without spaces or control characters');
  const key=(b.api_key as string | undefined) ?? '';
  if (key && key.length<8 || key && b.remove_credentials) throw new AccessError(400,'Choose either replacement credentials or removal');
  return {version:b.version,provider:b.provider as AiProvider,label:b.label.trim(),enabled:b.enabled,models:[...new Set(b.models)] as string[],api_key:key,remove_credentials:b.remove_credentials===true};
}
export async function saveAiConnection(id: string | null,body: unknown,actor: string) {
  if (id!==null && !validUuid(id)) throw new AccessError(400,'Invalid connection');
  const b=parseConnection(body);
  await transaction(async client=>{
    const settings=await lockSettings(client,b.version);
    const old=id ? (await client.query('SELECT * FROM ai_connections WHERE id=$1 FOR UPDATE',[id])).rows[0] : null;
    if (id && !old) throw new AccessError(404,'Connection not found');
    if (old && old.provider!==b.provider) throw new AccessError(400,'Create a separate connection for another provider');
    const credentials=b.remove_credentials ? null : b.api_key ? encrypt(b.api_key) : old?.credentials_encrypted ?? null;
    if (b.enabled && (!credentials || !b.models.length)) throw new AccessError(400,'An enabled connection needs credentials and at least one model');
    if (old && settings.default_connection_id===id && (!b.enabled || !credentials || !b.models.includes(settings.default_model))) throw new AccessError(409,'Choose another default model before disabling or changing this connection');
    if (!old && (await client.query('SELECT count(*)::int AS n FROM ai_connections')).rows[0].n>=20) throw new AccessError(400,'A maximum of 20 provider connections is supported');
    const connectionId=id ?? randomUUID(),reset=Boolean(b.api_key || b.remove_credentials);
    if (old) await client.query(`UPDATE ai_connections SET label=$2,enabled=$3,models=$4,credentials_encrypted=$5,version=version+1,updated_at=now(),
      last_test_at=CASE WHEN $6 THEN NULL ELSE last_test_at END,last_test_code=CASE WHEN $6 THEN NULL ELSE last_test_code END,
      available_models=CASE WHEN $6 THEN '[]'::jsonb ELSE available_models END WHERE id=$1`,[connectionId,b.label,b.enabled,JSON.stringify(b.models),credentials,reset]);
    else await client.query('INSERT INTO ai_connections(id,provider,label,enabled,models,credentials_encrypted) VALUES($1,$2,$3,$4,$5,$6)',[connectionId,b.provider,b.label,b.enabled,JSON.stringify(b.models),credentials]);
    await client.query('UPDATE ai_settings SET version=version+1 WHERE id=1');
    await event(client,connectionId,old ? 'connection_updated' : 'connection_created',actor,{provider:b.provider,credentials_changed:reset,credentials_removed:b.remove_credentials});
  });
  return aiSettings();
}
export async function deleteAiConnection(id: string,body: unknown,actor: string) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid connection');
  const b=object(body,['version']);
  await transaction(async client=>{
    await lockSettings(client,b.version);
    if (!(await client.query('SELECT id FROM ai_connections WHERE id=$1',[id])).rows.length) throw new AccessError(404,'Connection not found');
    await client.query('UPDATE ai_settings SET default_model=CASE WHEN default_connection_id=$1 THEN NULL ELSE default_model END,default_connection_id=CASE WHEN default_connection_id=$1 THEN NULL ELSE default_connection_id END,version=version+1 WHERE id=1',[id]);
    await event(client,id,'connection_deleted',actor,{connection_id:id});
    await client.query('DELETE FROM ai_connections WHERE id=$1',[id]);
  });
  return aiSettings();
}
export async function saveAiDefaults(body: unknown,actor: string) {
  const b=object(body,['version','default_connection_id','default_model','requests_per_user_day','max_output_tokens','max_tool_steps','retention_days']);
  const ranges=[['requests_per_user_day',1,10000],['max_output_tokens',256,32768],['max_tool_steps',1,10],['retention_days',0,90]] as const;
  for (const [key,min,max] of ranges) {
    // eslint-disable-next-line security/detect-object-injection -- Fixed limit names.
    const value=b[key];if (!Number.isInteger(value) || Number(value)<min || Number(value)>max) throw new AccessError(400,'Choose valid AI usage and retention limits');
  }
  if ((b.default_connection_id===null)!==(b.default_model===null) || b.default_connection_id!==null && (!validUuid(b.default_connection_id) || !validModelId(b.default_model))) throw new AccessError(400,'Choose a valid default connection and model');
  await transaction(async client=>{
    await lockSettings(client,b.version);
    if (b.default_connection_id) {
      const connection=(await client.query('SELECT enabled,models,credentials_encrypted IS NOT NULL AS has_key FROM ai_connections WHERE id=$1',[b.default_connection_id])).rows[0];
      if (!connection?.enabled || !connection.has_key || !connection.models.includes(b.default_model)) throw new AccessError(400,'Default must belong to an enabled connection with credentials');
    }
    await client.query(`UPDATE ai_settings SET default_connection_id=$1,default_model=$2,requests_per_user_day=$3,max_output_tokens=$4,max_tool_steps=$5,retention_days=$6,version=version+1 WHERE id=1`,[b.default_connection_id,b.default_model,b.requests_per_user_day,b.max_output_tokens,b.max_tool_steps,b.retention_days]);
    await event(client,null,'defaults_updated',actor);
  });
  return aiSettings();
}
export async function testAiConnection(id: string,body: unknown,actor: string,transport?: AiTransport) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid connection');
  const b=object(body,['version']),version=versionNumber(b.version);
  const row=(await query('SELECT id,provider,version,credentials_encrypted FROM ai_connections WHERE id=$1',[id]))[0];
  if (!row) throw new AccessError(404,'Connection not found');
  if (row.version!==version) throw new AccessError(409,'Connection changed. Reload before testing.');
  if (!row.credentials_encrypted) throw new AccessError(400,'Save API credentials before testing');
  let code='connected',models: string[]=[],truncated=false;
  try { const result=await checkAiProvider(row.provider as AiProvider,decrypt(row.credentials_encrypted as string),transport);models=result.models;truncated=result.truncated; }
  catch(e) { code=e instanceof AiProviderError ? e.code : 'credentials_unavailable'; }
  await transaction(async client=>{
    await client.query('SELECT id FROM ai_settings WHERE id=1 FOR UPDATE');
    const changed=await client.query('UPDATE ai_connections SET last_test_at=now(),last_test_code=$3,available_models=$4 WHERE id=$1 AND version=$2 RETURNING id',[id,version,code,JSON.stringify(models)]);
    if (!changed.rows.length) throw new AccessError(409,'Connection changed during the check. Test the saved version again.');
    await event(client,id,'connection_tested',actor,{code});
  });
  return {connected:code==='connected',code,models,truncated};
}
