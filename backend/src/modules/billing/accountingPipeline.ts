import {createHash,randomUUID} from 'crypto';
import {isIP} from 'net';
import {query,transaction} from '../../config/database';
import {AccessError,textReason} from './accessPolicy';
import {projectAccounting,type AccountingState} from './accountingProjection';
import {parseRadiusAccounting} from './radiusAccounting';
export async function enrollAccountingSource(body:unknown,actor:string){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new AccessError(400,'Accounting source details required');const b=body as Record<string,unknown>;
 if(Object.keys(b).some(k=>!['device_id','source_ip','nas_identifier','interim_seconds','reason'].includes(k))||typeof b.device_id!=='number'||!Number.isInteger(b.device_id)||b.device_id<1||b.device_id>2147483647||typeof b.source_ip!=='string'||!isIP(b.source_ip)||(/^(127\.|::ffff:127\.)/i.test(b.source_ip)||['::1','0.0.0.0','::'].includes(b.source_ip))||typeof b.nas_identifier!=='string'||!b.nas_identifier||b.nas_identifier.length>100||Array.from(b.nas_identifier).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||typeof b.interim_seconds!=='number'||!Number.isInteger(b.interim_seconds)||b.interim_seconds<30||b.interim_seconds>3600)throw new AccessError(400,'Choose a router, socket source IP, NAS identifier and interim interval (30–3600 seconds)');
 const reason=textReason(b.reason);
 return transaction(async c=>{if(!(await c.query("SELECT id FROM devices WHERE id=$1 AND device_type='router' FOR KEY SHARE",[b.device_id])).rows.length)throw new AccessError(404,'Router not found');const r=(await c.query(`INSERT INTO billing_accounting_sources(id,device_id,source_ip,nas_identifier,interim_seconds) VALUES($1,$2,$3,$4,$5) RETURNING id,device_id,host(source_ip) AS source_ip,nas_identifier,enabled,interim_seconds,version`,[randomUUID(),b.device_id,b.source_ip,b.nas_identifier,b.interim_seconds])).rows[0];await c.query("INSERT INTO audit_log(username,method,path,entity_type,entity_id,summary) VALUES($1,'POST','/api/billing/radius/sources','device',$2,$3)",[actor,b.device_id,JSON.stringify({source_id:r.id,reason})]);return r;});
}
export async function receiveEnrolledAccounting(body:unknown){
 const p=parseRadiusAccounting(body,true);
 if(!p.event_at||!p.nas_identifier||Date.parse(p.event_at)>Date.now()+30000)throw new AccessError(400,'Enrolled accounting requires Event-Timestamp and NAS-Identifier');
 return transaction(async c=>{
 const src=(await c.query('SELECT id,host(source_ip) AS canonical_ip FROM billing_accounting_sources WHERE source_ip=$1::inet AND nas_identifier=$2 AND enabled FOR SHARE',[p.source_ip,p.nas_identifier])).rows[0];
 if(!src)throw new AccessError(403,'Accounting source is not enabled');
 const fingerprint=createHash('sha256').update(JSON.stringify({source_id:src.id,...p,source_ip:src.canonical_ip})).digest('hex');
 const rows=(await c.query('INSERT INTO billing_accounting_inbox(id,source_id,fingerprint,packet) VALUES($1,$2,$3,$4) ON CONFLICT(fingerprint) DO NOTHING RETURNING id',[randomUUID(),src.id,fingerprint,JSON.stringify(p)])).rows;
 return {replayed:!rows.length};
 });
}
export async function projectNextAccounting(){
 return transaction(async c=>{
 const item=(await c.query(`SELECT i.*,i.received_at::text FROM billing_accounting_inbox i WHERE processed_at IS NULL AND attempts<5 AND next_attempt_at<=clock_timestamp() ORDER BY i.received_at,i.id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];if(!item)return false;
 await c.query('SAVEPOINT accounting_packet');
 try{
 const source=(await c.query('SELECT *,last_boundary_at::text FROM billing_accounting_sources WHERE id=$1 FOR UPDATE',[item.source_id])).rows[0];
 if(!source.enabled){await c.query("UPDATE billing_accounting_inbox SET next_attempt_at=now()+interval '30 seconds',last_code='source_disabled' WHERE id=$1",[item.id]);return true;}
 const p=item.packet as ReturnType<typeof parseRadiusAccounting>;const at=p.event_at!;
 if(source.last_boundary_at&&Date.parse(at)<Date.parse(source.last_boundary_at)){await c.query("UPDATE billing_accounting_inbox SET processed_at=now(),last_code='before_boot_boundary' WHERE id=$1",[item.id]);return true;}
 if(p.kind==='Accounting-On'||p.kind==='Accounting-Off'){
 await c.query('UPDATE billing_accounting_sources SET epoch=epoch+1,last_boundary_at=$2 WHERE id=$1',[source.id,at]);
 await c.query("UPDATE billing_network_sessions SET quality='nas_restart' WHERE source_id=$1 AND stopped_at IS NULL",[source.id]);
 }else{
 const previous=(await c.query(`SELECT *,started_at::text,last_observed_at::text,stopped_at::text,elapsed_seconds::float8,download_bytes::float8,upload_bytes::float8 FROM billing_network_sessions WHERE source_id=$1 AND epoch=$2 AND username=$3 AND session_key=$4 FOR UPDATE`,[source.id,source.epoch,p.username,p.session_key])).rows[0];
 // Only the latest saved router binding may attribute observations to a service.
 // No subscription or activation is inferred from a username.
 const service=(await c.query(`SELECT cs.id FROM billing_customer_services cs WHERE cs.username=$1 AND cs.mode='live' AND (SELECT b.device_id FROM billing_service_bindings b WHERE b.service_id=cs.id ORDER BY b.version DESC LIMIT 1)=$2`,[p.username,source.device_id])).rows[0];
 const projection=projectAccounting((previous as AccountingState|undefined)??null,{...p,event_at:at},item.received_at),s=projection.state,id=previous?.id??randomUUID();
 await c.query(`INSERT INTO billing_network_sessions(id,source_id,epoch,username,session_key,service_id,started_at,last_observed_at,stopped_at,elapsed_seconds,download_bytes,upload_bytes,start_seen,stop_seen,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
 ON CONFLICT(id) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at,stopped_at=EXCLUDED.stopped_at,elapsed_seconds=EXCLUDED.elapsed_seconds,download_bytes=EXCLUDED.download_bytes,upload_bytes=EXCLUDED.upload_bytes,start_seen=EXCLUDED.start_seen,stop_seen=EXCLUDED.stop_seen,quality=EXCLUDED.quality`,[id,source.id,source.epoch,p.username,p.session_key,service?.id??null,s.started_at,s.last_observed_at,s.stopped_at,s.elapsed_seconds,s.download_bytes,s.upload_bytes,s.start_seen,s.stop_seen,s.quality]);
 await c.query('INSERT INTO billing_accounting_deltas(inbox_id,session_id,kind,interval_start,interval_end,download_delta,upload_delta,download_bytes,upload_bytes,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[item.id,id,p.kind,projection.interval_start,projection.interval_end,projection.download_delta,projection.upload_delta,p.download_bytes,p.upload_bytes,projection.quality]);
 }
 await c.query("UPDATE billing_accounting_inbox SET processed_at=clock_timestamp(),last_code='projected' WHERE id=$1",[item.id]);
 }catch{
 await c.query('ROLLBACK TO SAVEPOINT accounting_packet');
 await c.query("UPDATE billing_accounting_inbox SET attempts=attempts+1,last_code='projection_failed',next_attempt_at=clock_timestamp()+least(300,power(2,attempts+1))*interval '1 second' WHERE id=$1",[item.id]);
 }
 return true;
 });
}
export async function pipelineDiagnostics(){
 const [accounting,provisioning,sources,health,sessions]=await Promise.all([
 query(`SELECT count(*)::int AS received,count(*) FILTER(WHERE processed_at IS NULL AND attempts<5)::int AS pending,count(*) FILTER(WHERE processed_at IS NULL AND attempts>=5)::int AS attention,max(received_at) AS last_received_at FROM billing_accounting_inbox`),
 query('SELECT state,count(*)::int AS total FROM billing_provisioning_runs GROUP BY state'),
 query('SELECT id,device_id,host(source_ip) AS source_ip,nas_identifier,enabled,interim_seconds,version FROM billing_accounting_sources ORDER BY created_at,id'),
 query('SELECT * FROM billing_pipeline_health'),
 query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE x.service_id IS NULL)::int AS unmapped,count(*) FILTER(WHERE x.stopped_at IS NULL AND x.last_observed_at<clock_timestamp()-s.interim_seconds*3*interval '1 second')::int AS stale FROM billing_network_sessions x JOIN billing_accounting_sources s ON s.id=x.source_id`),
 ]);return {accounting:accounting[0],provisioning,sources,health,sessions:sessions[0],authorization_enabled:false};
}

export async function setAccountingSource(id:string,body:unknown,actor:string){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new AccessError(400,'Source status required');const b=body as Record<string,unknown>;
 if(Object.keys(b).some(k=>!['enabled','version','reason'].includes(k))||typeof b.enabled!=='boolean'||!Number.isInteger(b.version)||Number(b.version)<1||Number(b.version)>=2147483647)throw new AccessError(400,'Choose source status and its current version');const reason=textReason(b.reason);
 return transaction(async c=>{const row=(await c.query('UPDATE billing_accounting_sources SET enabled=$2,version=version+1 WHERE id=$1 AND version=$3 RETURNING id,enabled,version',[id,b.enabled,b.version])).rows[0];if(!row)throw new AccessError(409,'Source changed or was removed. Refresh before updating');await c.query("INSERT INTO audit_log(username,method,path,summary) VALUES($1,'PUT','/api/billing/radius/sources/status',$2)",[actor,JSON.stringify({source_id:id,enabled:b.enabled,reason})]);return row;});
}
