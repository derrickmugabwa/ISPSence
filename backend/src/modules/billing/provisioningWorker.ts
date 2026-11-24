import {randomUUID} from 'crypto';
import {query,transaction} from '../../config/database';
export interface ProvisioningCommand {jobId:string;customerId:number;kind:string;scope:string;version:number;generation:number;desired:unknown}
export type ApplyOutcome={state:'accepted'}|{state:'not_applied';generation_retired:true}|{state:'unknown'};
export interface ProvisioningEvidence {jobId:string;scope:string;version:number;generation:number;observedAt:string;state:'applied'|'never_applied';generation_retired?:true}
// Only a qualified adapter may be supplied. It must persist a per-scope version/generation
// fence on the NAS and reject stale/retired commands. Database leases alone cannot do that.
export interface ProvisioningAdapter {supports:readonly string[];apply:(command:ProvisioningCommand,signal:AbortSignal)=>Promise<ApplyOutcome>;inspect:(command:ProvisioningCommand,signal:AbortSignal)=>Promise<ProvisioningEvidence|null>}
export async function discoverProvisioning(){
 await query(`INSERT INTO billing_provisioning_runs(job_id) SELECT j.id FROM billing_access_jobs j WHERE j.status='pending' AND NOT EXISTS(SELECT 1 FROM billing_provisioning_runs r WHERE r.job_id=j.id) ORDER BY j.created_at,j.id LIMIT 200 ON CONFLICT DO NOTHING`);
 await query(`UPDATE billing_provisioning_runs r SET state='superseded',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() FROM billing_access_jobs j WHERE j.id=r.job_id AND j.status='superseded' AND r.state NOT IN ('confirmed','superseded')`);
}
async function claimProvisioning(adapter?:ProvisioningAdapter){
 return transaction(async c=>{
 await c.query('SET LOCAL jit = off');
 const row=(await c.query(`SELECT r.*,j.customer_id,j.kind,j.scope_key,j.version,j.desired FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id
 WHERE j.status='pending' AND r.state NOT IN ('confirmed','attention','superseded') AND NOT EXISTS(SELECT 1 FROM billing_provisioning_runs other JOIN billing_access_jobs oj ON oj.id=other.job_id WHERE oj.customer_id=j.customer_id AND other.job_id<>r.job_id AND other.state IN ('applying','verifying','uncertain','attention')) AND r.next_attempt_at<=clock_timestamp() AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()) ORDER BY r.next_attempt_at,j.created_at,j.id LIMIT 1 FOR UPDATE OF r,j SKIP LOCKED`)).rows[0];if(!row)return null;
 if(!adapter||!adapter.supports.includes(row.kind)||['prepare','renewal'].includes(row.kind)){
 const uncertain=['applying','verifying','uncertain'].includes(row.state);
 const code=['prepare','renewal'].includes(row.kind)?'activation_protocol_required':'adapter_unavailable';
 if(!uncertain&&row.state!=='waiting_adapter')await c.query("INSERT INTO billing_provisioning_events(job_id,state,code,generation,attempts) VALUES($1,'waiting_adapter',$2,$3,$4)",[row.job_id,code,row.generation,row.attempts]);
 await c.query("UPDATE billing_provisioning_runs SET state=CASE WHEN state IN ('applying','verifying','uncertain') THEN 'uncertain' ELSE 'waiting_adapter' END,last_code=$2,next_attempt_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE job_id=$1",[row.job_id,code]);return 'deferred' as const;
 }
 const locked=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['provisioning:'+row.customer_id])).rows[0].locked;if(!locked)return null;
 if((await c.query(`SELECT r.job_id FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id WHERE j.customer_id=$1 AND r.job_id<>$2 AND r.state IN ('applying','verifying','uncertain','attention') LIMIT 1`,[row.customer_id,row.job_id])).rows.length)return null;
 const action=['applying','verifying','uncertain'].includes(row.state)?'probe':'apply';
 const token=randomUUID(),generation=action==='apply'?row.generation+1:row.generation,attempts=row.attempts+(action==='apply'?1:0);
 await c.query(`UPDATE billing_provisioning_runs SET state=$2,generation=$3,attempts=$4,lease_token=$5,lease_until=clock_timestamp()+interval '15 seconds',updated_at=clock_timestamp() WHERE job_id=$1`,[row.job_id,action==='apply'?'applying':'verifying',generation,attempts,token]);
 await c.query('INSERT INTO billing_provisioning_events(job_id,state,code,generation,attempts) VALUES($1,$2,$3,$4,$5)',[row.job_id,action==='apply'?'applying':'verifying','claimed_'+action,generation,attempts]);
 return {token,action,attempts,command:{jobId:row.job_id,customerId:row.customer_id,kind:row.kind,scope:row.scope_key,version:row.version,generation,desired:row.desired} as ProvisioningCommand};
 });
}
async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('adapter_timeout'));},5000);})]);}finally{if(timer)clearTimeout(timer);}
}
export async function runProvisioningOnce(adapter?:ProvisioningAdapter){
 const claim=await claimProvisioning(adapter);if(claim==='deferred')return true;if(!claim||!adapter)return false;
 let result:ApplyOutcome|ProvisioningEvidence|null=null;
 try{result=claim.action==='apply'?await bounded(signal=>adapter.apply(claim.command,signal)):await bounded(signal=>adapter.inspect(claim.command,signal));}catch{ /* timeout/exception is uncertain, never definite failure */ }
 await transaction(async c=>{
 await c.query('SET LOCAL jit = off');
 const row=(await c.query(`SELECT r.*,j.status AS job_status,clock_timestamp() AS now FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id WHERE r.job_id=$1 FOR UPDATE OF r,j`,[claim.command.jobId])).rows[0];
 if(!row||row.lease_token!==claim.token||new Date(row.lease_until).getTime()<=new Date(row.now).getTime()||row.generation!==claim.command.generation||row.job_status!=='pending')return;
 let state='uncertain',code='outcome_unknown';
 if(claim.action==='apply'){
 const r=result as ApplyOutcome|null;
 if(r?.state==='accepted'){state='verifying';code='acknowledged';}
 else if(r?.state==='not_applied'&&r.generation_retired===true){state=claim.attempts>=5?'attention':'retry';code='generation_retired';}
 }else{
 const r=result as ProvisioningEvidence|null;
 const fresh=r&&Number.isFinite(Date.parse(r.observedAt))&&Date.parse(r.observedAt)<=new Date(row.now).getTime()+1000&&Date.parse(r.observedAt)>=new Date(row.now).getTime()-60000;
 if(fresh&&r.jobId===claim.command.jobId&&r.scope===claim.command.scope&&r.version===claim.command.version&&r.generation===claim.command.generation){
 if(r.state==='applied'){state='confirmed';code='observed_applied';}
 else if(r.state==='never_applied'&&r.generation_retired===true){state=claim.attempts>=5?'attention':'retry';code='observed_never_applied';}
 }
 }
 const probes=Number(row.probes)+(claim.action==='probe'?1:0);if(state==='uncertain'&&probes>=20){state='attention';code='observation_exhausted';}
 const seconds=state==='retry'?Math.min(300,2**claim.attempts):state==='uncertain'?30:1;
 await c.query(`UPDATE billing_provisioning_runs SET state=$2,last_code=$3,lease_token=NULL,lease_until=NULL,probes=$4,next_attempt_at=clock_timestamp()+$5*interval '1 second',updated_at=clock_timestamp() WHERE job_id=$1`,[claim.command.jobId,state,code,probes,seconds]);
 await c.query('INSERT INTO billing_provisioning_events(job_id,state,code,generation,attempts) VALUES($1,$2,$3,$4,$5)',[claim.command.jobId,state,code,claim.command.generation,claim.attempts]);
 if(state==='confirmed')await c.query("UPDATE billing_access_jobs SET status='applied',last_error=NULL,updated_at=clock_timestamp() WHERE id=$1",[claim.command.jobId]);
 if(state==='attention')await c.query("UPDATE billing_access_jobs SET status='failed',last_error=$2,updated_at=clock_timestamp() WHERE id=$1",[claim.command.jobId,code]);
 });return true;
}
