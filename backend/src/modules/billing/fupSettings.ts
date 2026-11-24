import { query,transaction } from '../../config/database';
import { AccessError,lockCustomer,textReason,versionNumber } from './accessPolicy';
import { managementEvent } from './accessManagement';
import { parseFup,type FupPolicy } from './fup';
export const FUP_SCHEMA = `ALTER TABLE billing_packages ADD COLUMN IF NOT EXISTS fup_policy JSONB CHECK(fup_policy IS NULL OR jsonb_typeof(fup_policy)='object');
CREATE TABLE IF NOT EXISTS billing_customer_fup (
 customer_id INTEGER PRIMARY KEY REFERENCES billing_customers(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN ('inherit','custom','exempt')),
 policy JSONB, expires_at TIMESTAMPTZ,version INTEGER NOT NULL CHECK(version>0),reason TEXT NOT NULL,actor TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((mode='custom' AND policy IS NOT NULL AND jsonb_typeof(policy)='object') OR (mode<>'custom' AND policy IS NULL)),
 CHECK(mode<>'inherit' OR expires_at IS NULL)
);`;
export async function customerFup(customerId:number){
 const rows=await query('SELECT mode,policy,expires_at,version,updated_at FROM billing_customer_fup WHERE customer_id=$1',[customerId]);
 const setting=rows[0]??{mode:'inherit',policy:null,expires_at:null,version:0,updated_at:null};
 const effectiveMode=setting.expires_at && new Date(String(setting.expires_at)).getTime()<=Date.now()?'inherit':setting.mode;
 const periods=await query(`SELECT s.id,s.status,coalesce(p.package_snapshot,g.package_snapshot) AS terms
 FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
 WHERE coalesce(p.customer_id,g.customer_id)=$1 ORDER BY s.created_at DESC,s.id LIMIT 50`,[customerId]);
 return {setting,effective_mode:effectiveMode,enforcement:'awaiting_production_accounting',periods:periods.map(p=>{
 const terms=p.terms as Record<string,unknown>;return {id:p.id,status:p.status,package_name:terms.name,policy:effectiveMode==='exempt'?null:effectiveMode==='custom'?setting.policy:terms.fup_policy??null,source:effectiveMode==='inherit'?'purchased_terms':effectiveMode,hard_allowance_bytes:terms.allowance_bytes??null,usage_bytes:null};
 })};
}
export async function saveCustomerFup(id:number,body:unknown,actor:string){
 if(!body || typeof body!=='object' || Array.isArray(body))throw new AccessError(400,'FUP settings are required');
 const b=body as Record<string,unknown>;
 if(Object.keys(b).some(k=>!['mode','policy','expires_at','version','reason'].includes(k)) || (typeof b.mode!=='string'||!['inherit','custom','exempt'].includes(b.mode)))throw new AccessError(400,'Choose package defaults, a custom FUP policy or an exemption');
 const version=versionNumber(b.version),reason=textReason(b.reason);let policy;
 try{policy=b.mode==='custom'?parseFup(b.policy):null;}catch(e){throw new AccessError(400,(e as Error).message);}
 if(b.mode==='custom'&&!policy || b.mode!=='custom'&&b.policy!==null&&b.policy!==undefined)throw new AccessError(400,'Only a custom FUP setting accepts a policy');
 const expires=b.expires_at===null||b.expires_at===undefined?null:b.expires_at;
 if(expires!==null&&(b.mode==='inherit'||typeof expires!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expires)||!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()))throw new AccessError(400,'Choose a future expiry with a timezone, or leave it empty');
 await transaction(async client=>{
 await lockCustomer(client,id);
 const current=(await client.query('SELECT version FROM billing_customer_fup WHERE customer_id=$1 FOR UPDATE',[id])).rows[0];
 if((current?.version??0)!==version)throw new AccessError(409,'FUP settings changed. Reload before saving');
 await client.query(`INSERT INTO billing_customer_fup(customer_id,mode,policy,expires_at,version,reason,actor) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(customer_id) DO UPDATE SET mode=EXCLUDED.mode,policy=EXCLUDED.policy,expires_at=EXCLUDED.expires_at,version=EXCLUDED.version,reason=EXCLUDED.reason,actor=EXCLUDED.actor,updated_at=now()`,[id,b.mode,policy?JSON.stringify(policy):null,expires,version+1,reason,actor]);
 await managementEvent(client,id,'fup_policy_changed',actor,reason,{mode:b.mode,policy,expires_at:expires,version:version+1});
 });
 return customerFup(id);
}

export async function fupWindow(policy:FupPolicy,activation:string,expires:string,asOf:string){
 parseFup(policy);
 const a=Date.parse(activation),e=Date.parse(expires),n=Date.parse(asOf);
 if(![a,e,n].every(Number.isFinite)||e<=a||n<a||n>=e)throw new AccessError(409,'FUP requires an effective, unexpired access period');
 if(policy.reset==='subscription')return {start:new Date(a).toISOString(),end:new Date(e).toISOString()};
 const unit={daily:'day',weekly:'week',monthly:'month'}[policy.reset];
 return (await query(`SELECT greatest($1::timestamptz,date_trunc($4::text,$3::timestamptz AT TIME ZONE $5::text) AT TIME ZONE $5::text) AS start,
 least($2::timestamptz,(date_trunc($4::text,$3::timestamptz AT TIME ZONE $5::text)+CASE $4::text WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' ELSE interval '1 month' END) AT TIME ZONE $5::text) AS "end"`,[activation,expires,asOf,unit,policy.timezone]))[0];
}
