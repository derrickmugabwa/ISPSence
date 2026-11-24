// Disposable PostgreSQL fixtures and a controlled adapter. No router/provider I/O.
const assert=require('node:assert/strict'),{Pool}=require('pg'),{randomUUID}=require('node:crypto');
async function main(){
 const schema='network_pipeline_'+randomUUID().replace(/-/g,'');const url=new URL(process.env.DATABASE_URL);if(process.env.DB_PASSWORD)url.password=encodeURIComponent(process.env.DB_PASSWORD);
 const control=new Pool({connectionString:url.toString(),options:'-c search_path=public'});let pool;
 try{
 await control.query('CREATE SCHEMA "'+schema+'"');
 for(const {tablename} of (await control.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'billing_%' OR tablename='devices') ORDER BY tablename")).rows){assert.match(tablename,/^[a-z0-9_]+$/);await control.query('CREATE TABLE "'+schema+'"."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING ALL)');}
 process.env.PGOPTIONS='-c search_path='+schema;
 ({pool}=require('/app/dist/config/database'));
 await pool.query('CREATE TABLE audit_log(username text,method text,path text,entity_type text,entity_id integer,summary text)');
 await pool.query(require('/app/dist/modules/billing/networkPipelineSchema').NETWORK_PIPELINE_SCHEMA);
 const pipe=require('/app/dist/modules/billing/accountingPipeline'),worker=require('/app/dist/modules/billing/provisioningWorker'),sessions=require('/app/dist/modules/billing/sessions');
 await pool.query("INSERT INTO devices(id,name,ip_address,api_username,api_password_encrypted,device_type) VALUES(2147000000,'Fictional NAS','192.0.2.5','fixture','UNUSED','router')");
 await pool.query("INSERT INTO billing_customers(id,full_name) VALUES(2147000000,'Fictional subscriber'),(2147000001,'Other fictional subscriber')");
 const service=randomUUID();await pool.query("INSERT INTO billing_customer_services(id,customer_id,service_type,mode,username,label,state,request_key,request_payload) VALUES($1,2147000000,'pppoe','live','fixture-cpe','Fictional PPPoE','draft',$2,'{}')",[service,randomUUID()]);
 await pool.query("INSERT INTO billing_service_bindings(id,service_id,device_id,discovery_id,server_id,service_name,interface_name,profile_name,pool_name,version,request_key,request_payload,actor,reason) VALUES($1,$2,2147000000,$3,'server','service','ether1','profile','pool',2,$4,'{}','fixture','Fixture')",[randomUUID(),service,randomUUID(),randomUUID()]);
 const prepared=await pipe.enrollAccountingSource({device_id:2147000000,source_ip:'192.0.2.5',nas_identifier:'fixture-nas',interim_seconds:60,reason:'Fixture'},'fixture');assert.equal(prepared.enabled,false);
 const base=Math.floor(Date.now()/1000)-300;const a=value=>({value:[value]});
 const packet=(kind,elapsed,down,up,key='session-1')=>({'Tmp-IP-Address-0':a('192.0.2.5'),'NAS-Identifier':a('fixture-nas'),'Acct-Status-Type':a(kind),'Event-Timestamp':a(base+elapsed),'User-Name':a('fixture-cpe'),'Acct-Session-Id':a(key),'Acct-Session-Time':a(elapsed),'Acct-Output-Octets':a(down),'Acct-Input-Octets':a(up)});
 await assert.rejects(pipe.receiveEnrolledAccounting(packet('Start',0,0,0)),{status:403});
 await pipe.setAccountingSource(prepared.id,{enabled:true,version:1,reason:'Enable fictional source'},'fixture');
 const same=await Promise.all(Array.from({length:8},()=>pipe.receiveEnrolledAccounting(packet('Start',0,0,0))));assert.equal(same.filter(r=>!r.replayed).length,1);
 await pipe.projectNextAccounting();
 await pipe.receiveEnrolledAccounting(packet('Interim-Update',60,100,20));await pipe.projectNextAccounting();
 await pipe.receiveEnrolledAccounting(packet('Interim-Update',30,50,10));await pipe.projectNextAccounting();
 await pipe.receiveEnrolledAccounting(packet('Stop',120,150,30));await pipe.projectNextAccounting();
 let record=(await pool.query("SELECT * FROM billing_network_sessions WHERE session_key='session-1'")).rows[0];assert.equal(Number(record.download_bytes),150);assert.ok(record.stopped_at);assert.equal(record.service_id,service);
 const sum=(await pool.query('SELECT sum(download_delta)::int AS down,sum(upload_delta)::int AS up FROM billing_accounting_deltas')).rows[0];assert.deepEqual(sum,{down:150,up:30});
 const history=await sessions.sessionList('','all',0,2147000000);assert.equal(history.items.length,1);assert.equal(history.items[0].source,'radius');assert.equal(history.items[0].subscription_id,null);assert.equal(history.items[0].funding,'unattributed');assert.equal((await sessions.sessionDetail(record.id)).events.length,4);
 console.log('PASS: disabled/unregistered ingress protection, concurrent dedupe, durable projection, late packets, exact deltas and shared customer history without invented billing attribution');
 await pipe.receiveEnrolledAccounting(packet('Interim-Update',60,700,70,'missing-start'));await pipe.projectNextAccounting();
 assert.equal((await pool.query("SELECT quality FROM billing_network_sessions WHERE session_key='missing-start'")).rows[0].quality,'missing_start');
 await pipe.receiveEnrolledAccounting(packet('Start',0,0,0,'reset'));await pipe.projectNextAccounting();await pipe.receiveEnrolledAccounting(packet('Interim-Update',60,900,90,'reset'));await pipe.projectNextAccounting();await pipe.receiveEnrolledAccounting(packet('Interim-Update',120,10,1,'reset'));await pipe.projectNextAccounting();assert.equal((await pool.query("SELECT quality FROM billing_network_sessions WHERE session_key='reset'")).rows[0].quality,'counter_reset');
 const boundary={...packet('Accounting-On',180,0,0)};await pipe.receiveEnrolledAccounting(boundary);await pipe.projectNextAccounting();
 await pipe.receiveEnrolledAccounting(packet('Interim-Update',150,1000,100,'reset'));await pipe.projectNextAccounting();assert.equal((await pool.query("SELECT last_code FROM billing_accounting_inbox ORDER BY received_at DESC LIMIT 1")).rows[0].last_code,'before_boot_boundary');
 await pipe.receiveEnrolledAccounting({...packet('Start',0,0,0,'bad'), 'Event-Timestamp':a(base+200)});await pipe.projectNextAccounting();
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_network_sessions WHERE session_key='bad'")).rows[0].n,1);
 // Poison packets stay durable, with bounded retries rather than blocking other work.
 const poison=randomUUID();await pool.query("INSERT INTO billing_accounting_inbox(id,source_id,fingerprint,packet) VALUES($1,$2,$3,'{}')",[poison,prepared.id,randomUUID()]);for(let i=0;i<5;i++){await pool.query("UPDATE billing_accounting_inbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[poison]);await pipe.projectNextAccounting();}assert.equal((await pool.query('SELECT attempts FROM billing_accounting_inbox WHERE id=$1',[poison])).rows[0].attempts,5);
 assert.equal((await pipe.pipelineDiagnostics()).accounting.attention,1);
 console.log('PASS: incomplete/reset accounting stays unverified, boot epochs isolate reused IDs, old epochs cannot reopen sessions, poison packets are bounded and observable');
 async function job(kind='speed',customer=2147000000){const id=randomUUID();await pool.query("INSERT INTO billing_access_jobs(id,customer_id,kind,scope_key,version,desired,status,reason,actor) VALUES($1,$2,$3,$4,1,'{}','pending','Fixture','fixture')",[id,customer,kind,id]);await worker.discoverProvisioning();return id;}
 const waiting=await job();await worker.runProvisioningOnce();let run=(await pool.query('SELECT * FROM billing_provisioning_runs WHERE job_id=$1',[waiting])).rows[0];assert.equal(run.state,'waiting_adapter');assert.equal(run.attempts,0);
 const adapter={supports:['speed','prepare'],applies:0,probes:0,apply:async()=>{adapter.applies++;return {state:'accepted'};},inspect:async c=>{adapter.probes++;return {jobId:c.jobId,scope:c.scope,version:c.version,generation:c.generation,observedAt:new Date().toISOString(),state:'applied'};}};
 async function due(id){await pool.query("UPDATE billing_provisioning_runs SET next_attempt_at=now()-interval '1 second' WHERE job_id=$1",[id]);}
 await due(waiting);await worker.runProvisioningOnce(adapter);assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[waiting])).rows[0].state,'verifying');assert.equal((await pool.query('SELECT status FROM billing_access_jobs WHERE id=$1',[waiting])).rows[0].status,'pending');await due(waiting);await worker.runProvisioningOnce(adapter);assert.equal(adapter.applies,1);assert.equal(adapter.probes,1);assert.equal((await pool.query('SELECT status FROM billing_access_jobs WHERE id=$1',[waiting])).rows[0].status,'applied');
 console.log('PASS: absent adapter never invents failure/success; acknowledgement is separate from independently observed application');
 const unknown=await job();const uncertain={...adapter,apply:async()=>{throw new Error('PRIVATE ERROR');},inspect:adapter.inspect};await worker.runProvisioningOnce(uncertain);assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[unknown])).rows[0].state,'uncertain');await due(unknown);const before=adapter.applies;await worker.runProvisioningOnce(adapter);assert.equal(adapter.applies,before);assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[unknown])).rows[0].state,'confirmed');
 const restart=await job();await pool.query("UPDATE billing_provisioning_runs SET state='applying',generation=1,attempts=1,lease_token=$2,lease_until=now()-interval '1 second' WHERE job_id=$1",[restart,randomUUID()]);await worker.runProvisioningOnce(adapter);assert.equal(adapter.applies,before);
 const prepare=await job('prepare');await worker.runProvisioningOnce(adapter);assert.equal((await pool.query('SELECT last_code FROM billing_provisioning_runs WHERE job_id=$1',[prepare])).rows[0].last_code,'activation_protocol_required');
 console.log('PASS: uncertain and crash-recovered work probes instead of reapplying; activation cannot bypass its separate readiness protocol');
 const mismatch=await job('speed',2147000001);await worker.runProvisioningOnce(adapter);await due(mismatch);
 await worker.runProvisioningOnce({...adapter,inspect:async c=>({...await adapter.inspect(c),generation:c.generation+1})});
 assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[mismatch])).rows[0].state,'uncertain');
 await due(mismatch);await worker.runProvisioningOnce();assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[mismatch])).rows[0].state,'uncertain');
 await due(mismatch);const applyCount=adapter.applies;await worker.runProvisioningOnce(adapter);assert.equal(adapter.applies,applyCount);
 const stale=await job('speed',2147000001);
 await worker.runProvisioningOnce({...adapter,apply:async c=>{await pool.query('UPDATE billing_provisioning_runs SET lease_token=$2 WHERE job_id=$1',[c.jobId,randomUUID()]);return {state:'accepted'};}});
 assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[stale])).rows[0].state,'applying');
 await pool.query("UPDATE billing_provisioning_runs SET lease_until=now()-interval '1 second' WHERE job_id=$1",[stale]);await worker.runProvisioningOnce(adapter);
 assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[stale])).rows[0].state,'confirmed');
 const concurrent=await job('speed',2147000001);await job('speed',2147000001);
 let entered,release;const entry=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const running=worker.runProvisioningOnce({...adapter,apply:async()=>{entered();await gate;return {state:'accepted'};}});
 await entry;assert.equal(await worker.runProvisioningOnce(adapter),false);release();await running;
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id WHERE j.customer_id=2147000001 AND r.state='verifying'")).rows[0].n,1);
 await due(concurrent);await worker.runProvisioningOnce(adapter);await worker.runProvisioningOnce(adapter);
 const remaining=(await pool.query("SELECT job_id FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id WHERE j.customer_id=2147000001 AND r.state='verifying'")).rows[0];await due(remaining.job_id);await worker.runProvisioningOnce(adapter);
 console.log('PASS: mismatched generation evidence rejected, missing adapter preserves uncertainty, stale lease writer ignored, and overlapping workers serialize customer changes');
 const failed=await job('speed',2147000001);const definite={...adapter,apply:async()=>({state:'not_applied',generation_retired:true})};for(let i=0;i<5;i++){await due(failed);await worker.runProvisioningOnce(definite);}assert.equal((await pool.query('SELECT state FROM billing_provisioning_runs WHERE job_id=$1',[failed])).rows[0].state,'attention');assert.equal((await pool.query('SELECT status FROM billing_access_jobs WHERE id=$1',[failed])).rows[0].status,'failed');
 const logs=JSON.stringify((await pool.query('SELECT * FROM billing_provisioning_events')).rows);assert.ok(!logs.includes('PRIVATE ERROR'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_subscriptions WHERE activation_at IS NOT NULL')).rows[0].n,0);
 console.log('PASS: definite fenced failures back off and stop after five attempts, events are sanitized, and no paid activation is fabricated');
 }finally{if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await control.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
