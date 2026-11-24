// Saved-credential/funding tests use only a disposable schema and random keys.
const assert=require('node:assert/strict');
const {randomUUID,randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const fs=require('node:fs/promises');
const {Pool}=require('pg');
const a=value=>({value:[value]});
async function main(){
  const schema='pppoe_auth_lab_'+randomUUID().replace(/-/g,'');
  process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.SECRETS_DIR='/tmp/'+schema;
  const url=new URL(process.env.DATABASE_URL);if(process.env.DB_PASSWORD)url.password=encodeURIComponent(process.env.DB_PASSWORD);
  const control=new Pool({connectionString:url.toString(),options:'-c search_path=public'});
  let pool,server;let now=new Date();const initial=new Date();const passwords=[];
  try{
    if(process.argv.includes('--serve'))await fs.rm('/lab/fixture.env',{force:true});
    await control.query('CREATE SCHEMA "'+schema+'"');process.env.PGOPTIONS='-c search_path='+schema;
    ({pool}=require('/app/dist/config/database'));
    await pool.query('CREATE TABLE devices(id INTEGER PRIMARY KEY,name TEXT)');
    await pool.query("INSERT INTO devices VALUES(777,'Fictional NAS')");
    for(const [file,key]of [['packages','PACKAGE_SCHEMA'],['customersPayments','CUSTOMERS_PAYMENTS_SCHEMA'],['subscriptions','SUBSCRIPTIONS_SCHEMA'],['customerAccess','CUSTOMER_ACCESS_SCHEMA'],['sessions','SESSIONS_SCHEMA'],['accessManagementSchema','ACCESS_MANAGEMENT_SCHEMA']])await pool.query(require('/app/dist/modules/billing/'+file)[key]);
    const migration=await pool.connect();try{await require('/app/dist/modules/billing/customerServicesSchema').migrateCustomerServices(migration);}finally{migration.release();}
    await pool.query(require('/app/dist/modules/billing/portals').PORTALS_SCHEMA);
    await pool.query(require('/app/dist/modules/billing/payheroSchema').PAYHERO_SCHEMA);
    await pool.query("INSERT INTO billing_packages(name,amount_minor,duration_value,duration_unit,download_bps,upload_bps,service_types) VALUES('Lab day',1000,1,'day',5000000,2000000,ARRAY['pppoe']),('Lab month',2000,1,'calendar_month',5000000,2000000,ARRAY['pppoe'])");
    const {PppoeLab}=require('/app/dist/modules/billing/pppoeLab');
    const lab=await PppoeLab.create(pool,schema,()=>new Date(now));
    // Independent mock NAS probe: tests explicitly choose when access became usable.
    const ready=async(id,session,version=3,usableAt)=>lab.confirmReady(id,session,version,usableAt??(await pool.query('SELECT started_at FROM pppoe_lab_admissions WHERE id=$1',[id])).rows[0].started_at??new Date(now));
    const {createServiceDraft}=require('/app/dist/modules/billing/customerServices');
    const {generateServiceCredentials}=require('/app/dist/modules/billing/serviceCredentials');
    const {saveServiceBinding}=require('/app/dist/modules/billing/serviceBindings');
    const {grantComplimentary,parseGrant}=require('/app/dist/modules/billing/customerAccess');
    const grant=async(f,packageId=1)=>{
      await grantComplimentary(parseGrant({service_id:f.id,package_id:packageId,package_version:1,mode:'live',reason:'Disposable lab grant',request_key:randomUUID(),confirm_complimentary:true},f.customer),'fixture');
      return (await pool.query('SELECT subscription_id FROM billing_service_periods WHERE service_id=$1 ORDER BY queue_sequence DESC LIMIT 1',[f.id])).rows[0].subscription_id;
    };
    const make=async(kind='free',options={})=>{
      const customer=options.customer??(await pool.query("INSERT INTO billing_customers(full_name) VALUES('Disposable protocol customer') RETURNING id")).rows[0].id;
      const service=(await createServiceDraft({customer_id:customer,username:options.username??'lab-'+randomUUID().replace(/-/g,''),label:'Lab connection',reason:'Disposable test',request_key:randomUUID()},'fixture')).service;
      const credentials=await generateServiceCredentials(service.id,{version:1,reason:'Lab password',request_key:randomUUID()},'fixture');passwords.push(credentials.password);
      const inventory={ros_version:'7.20',servers:[{id:'*1',service_name:'fixture-internet',interface:'vlan20',default_profile:'home',disabled:false,authentication:['pap','chap']}],profiles:[{name:'home',local_address:'10.20.0.1',remote_address:'fixture-pool'}],pools:[{name:'fixture-pool',ranges:'10.20.0.2-10.20.0.254'}],radius_enabled:false,ppp_radius_clients:0,local_username_collision:false};
      const discovery=randomUUID();await pool.query('INSERT INTO billing_pppoe_discoveries(id,service_id,device_id,service_version,inventory) VALUES($1,$2,777,2,$3)',[discovery,service.id,JSON.stringify(inventory)]);
      await saveServiceBinding(service.id,{version:2,discovery_id:discovery,server_id:'*1',profile_name:'home',pool_name:'fixture-pool',cpe_mac:'02:00:00:00:00:01',reason:'Lab binding',request_key:randomUUID()},'fixture');
      await pool.query("INSERT INTO pppoe_lab_enrollments VALUES($1,3,'db-lab','127.0.0.1',true)",[service.id]);
      const f={id:service.id,customer,password:credentials.password,username:service.username};
      if(kind==='free')f.period=await grant(f,options.packageId??1);
      if(kind==='paid'||kind==='unpaid'){
        const id=randomUUID();const offer=(await pool.query('SELECT * FROM billing_packages WHERE id=1')).rows[0];
        const terms={...offer,service_type:'pppoe',service_id:service.id,timezone:'Africa/Nairobi',start_policy:'access_ready'};
        await pool.query('INSERT INTO billing_purchases(id,reference,request_key,customer_id,package_id,payer_phone,amount_minor,currency,package_snapshot,service_id) VALUES($1,$2,$3,$4,1,$5,1000,$6,$7,$8)',[id,id.replace(/-/g,''),randomUUID(),customer,'+254700000000','KES',JSON.stringify(terms),service.id]);f.purchase=id;
        if(kind==='paid'){
          await require('/app/dist/modules/billing/paymentReceipts').recordManualReceipt(id,{method:'cash',reference:'',paid_at:new Date().toISOString(),notes:'Fictional lab receipt',confirm_received:true,request_key:randomUUID()},'fixture');
          f.period=(await pool.query('SELECT subscription_id FROM billing_service_periods WHERE service_id=$1',[f.id])).rows[0].subscription_id;
        }
      }
      return f;
    };
    const request=(f,fields={})=>({'User-Name':a(f.username),'User-Password':a(f.password),'NAS-Identifier':a('db-lab'),'Tmp-IP-Address-0':a('127.0.0.1'),'Tmp-Octets-0':a('0x'+randomBytes(16).toString('hex')),'Calling-Station-Id':a('02:00:00:00:00:01'),'Called-Station-Id':a('fixture-internet'),'Service-Type':a('Framed-User'),'Framed-Protocol':a('PPP'),...fields});
    const admissionId=r=>r['reply:Class'].slice(4);
    const account=(f,r,kind,session,fields={})=>({'User-Name':a(f.username),'NAS-Identifier':a('db-lab'),'Tmp-IP-Address-0':a('127.0.0.1'),'Calling-Station-Id':a('02:00:00:00:00:01'),'Acct-Status-Type':a(kind),'Acct-Session-Id':a(session),'Acct-Session-Time':a(kind==='Start'?0:10),'Event-Timestamp':a(now.toISOString()),'Framed-IP-Address':a('10.20.0.2'),'Class':a(r['reply:Class']),...fields});
    const denied=promise=>assert.rejects(promise,e=>[400,403,409].includes(e.status));
    const controlState=(f,state)=>pool.query("INSERT INTO billing_customer_controls(customer_id,desired_state,version,reason,actor) VALUES($1,$2,1,'Fixture','fixture') ON CONFLICT(customer_id) DO UPDATE SET desired_state=$2,version=billing_customer_controls.version+1",[f.customer,state]);
    const free=await make();const unpaid=await make('unpaid');
    await denied(lab.authenticate(request(unpaid)));
    for(const fields of [{'User-Password':a('wrong')},{'NAS-Identifier':a('wrong')},{'Called-Station-Id':a('wrong')},{'Calling-Station-Id':a('02:00:00:00:00:02')},{'Tmp-IP-Address-0':a('192.0.2.1')},{'User-Name':a('unknown')}])await denied(lab.authenticate(request(free,fields)));
    await controlState(free,'suspended');await denied(lab.authenticate(request(free)));
    await controlState(free,'vacation');await denied(lab.authenticate(request(free)));
    await controlState(free,'enabled');
    const outside={enabled:true,timezone:'UTC',windows:[{days:[(now.getUTCDay()+1)%7],start:'00:01',end:'00:02'}]};
    await pool.query('INSERT INTO billing_access_policy(customer_id,schedule) VALUES($1,$2)',[free.customer,JSON.stringify(outside)]);await denied(lab.authenticate(request(free)));
    await pool.query("UPDATE billing_access_policy SET schedule='{"+ '"enabled":false,"timezone":"UTC","windows":[]' +"}' WHERE customer_id=$1",[free.customer]);
    await pool.query("INSERT INTO billing_customer_network(customer_id,download_bps,upload_bps,reason,actor,version) VALUES($1,4000000,1000000,'Fixture','fixture',1)",[free.customer]);
    const exact=request(free);const simultaneous=await Promise.all(Array.from({length:6},()=>lab.authenticate(exact)));
    assert.equal(new Set(simultaneous.map(r=>r['reply:Class'])).size,1);assert.equal(simultaneous[0]['reply:Mikrotik-Rate-Limit'],'1000000/4000000');
    now=new Date(now.getTime()+2000);assert.ok((await lab.authenticate(exact))['reply:Session-Timeout']<simultaneous[0]['reply:Session-Timeout']);
    await denied(lab.authenticate(request(free)));
    console.log('PASS: saved PAP password, verified funding, wrong NAS/service/CPE/password, suspension/vacation/schedule, speed override, durable request replay and concurrent admission limits');

    const paid=await make('paid');const reply=await lab.authenticate(request(paid));const id=admissionId(reply),session=randomUUID();
    const startAt=new Date(now);await denied(ready(id,session,3));
    assert.equal((await pool.query('SELECT activation_at FROM pppoe_lab_periods WHERE subscription_id=$1',[paid.period])).rows[0].activation_at,null);
    await denied(lab.accounting(account(paid,reply,'Start',session,{'NAS-Identifier':a('wrong')})));
    const start=account(paid,reply,'Start',session);await lab.accounting(start);assert.equal((await lab.accounting(start)).replayed,true);
    assert.equal((await pool.query('SELECT activation_at FROM pppoe_lab_periods WHERE subscription_id=$1',[paid.period])).rows[0].activation_at,null);
    now=new Date(now.getTime()+3000);const effective=await ready(id,session,3);assert.equal(effective.activation_at.toISOString(),startAt.toISOString());
    assert.deepEqual(await ready(id,session,3),effective);
    await lab.accounting(account(paid,reply,'Interim-Update',session,{'Acct-Input-Gigawords':a(1),'Acct-Input-Octets':a(123),'Acct-Output-Octets':a(90000)}));
    await lab.accounting(account(paid,reply,'Stop',session,{'Acct-Input-Gigawords':a(1),'Acct-Input-Octets':a(223),'Acct-Output-Octets':a(91000)}));
    await lab.accounting(account(paid,reply,'Interim-Update',session,{'Acct-Input-Octets':a(1),'Acct-Output-Octets':a(1)}));
    const stopped=(await pool.query('SELECT * FROM pppoe_lab_admissions WHERE id=$1',[id])).rows[0];assert.equal(stopped.state,'stopped');assert.equal(Number(stopped.upload_bytes),4294967519);assert.equal(Number(stopped.download_bytes),91000);
    const reconnect=await lab.authenticate(request(paid));const session2=randomUUID();await lab.accounting(account(paid,reconnect,'Start',session2));assert.deepEqual(await ready(admissionId(reconnect),session2,3),effective);await lab.accounting(account(paid,reconnect,'Stop',session2));
    const nextPeriod=await grant(paid);now=new Date(effective.expires_at.getTime()-1000);await denied(lab.authenticate(request(paid)));
    now=new Date(effective.expires_at.getTime()+1000);const renewed=await lab.authenticate(request(paid));assert.equal((await pool.query('SELECT subscription_id FROM pppoe_lab_admissions WHERE id=$1',[admissionId(renewed)])).rows[0].subscription_id,nextPeriod);
    assert.deepEqual((await pool.query('SELECT * FROM pppoe_lab_periods WHERE subscription_id=$1',[paid.period])).rows[0],effective);
    console.log('PASS: Class-correlated Start/Interim/Stop, durable duplicate ACK, gigawords/direction, late packets, separate readiness, earliest observed start, immutable effective timestamps, reconnect and queued renewal');

    const delayed=await make();const delayedReply=await lab.authenticate(request(delayed)),delayedAt=new Date(now);now=new Date(now.getTime()+10000);
    await lab.accounting(account(delayed,delayedReply,'Start','delayed-start',{'Event-Timestamp':a(delayedAt.toISOString())}));
    assert.equal((await ready(admissionId(delayedReply),'delayed-start',3)).activation_at.toISOString(),delayedAt.toISOString());

    const stalled=await make();const stalledReply=await lab.authenticate(request(stalled)),stalledSession=randomUUID();
    await lab.accounting(account(stalled,stalledReply,'Start',stalledSession));now=new Date(now.getTime()+10000);
    await denied(ready(admissionId(stalledReply),stalledSession,3,new Date(now.getTime()+1000)));
    const usableAt=new Date(now);const stalledTimes=await ready(admissionId(stalledReply),stalledSession,3,usableAt);
    assert.equal(stalledTimes.activation_at.toISOString(),usableAt.toISOString());
    assert.equal(stalledTimes.expires_at.getTime()-stalledTimes.activation_at.getTime(),86400000);
    console.log('PASS: delayed Start preserves earlier verified access, forwarding delay consumes no purchased time, and future readiness evidence is rejected');

    now=new Date(initial);const missing=await make();const missingReply=await lab.authenticate(request(missing));now=new Date(now.getTime()+65000);
    await denied(lab.authenticate(request(missing)));await denied(lab.confirmNeverEnabled(admissionId(missingReply),false));
    await lab.confirmNeverEnabled(admissionId(missingReply),true);const rescheduled=await lab.authenticate(request(missing));assert.notEqual(admissionId(rescheduled),admissionId(missingReply));
    assert.equal((await pool.query('SELECT activation_at FROM pppoe_lab_periods WHERE subscription_id=$1',[missing.period])).rows[0].activation_at,null);
    await denied(lab.accounting(account(missing,missingReply,'Start','late')));
    const stale=await make();const staleReply=await lab.authenticate(request(stale)),staleSession=randomUUID();await lab.accounting(account(stale,staleReply,'Start',staleSession));await ready(admissionId(staleReply),staleSession,3);now=new Date(now.getTime()+600000);await denied(lab.authenticate(request(stale)));await lab.accounting(account(stale,staleReply,'Stop',staleSession));await lab.authenticate(request(stale));
    const revoked=await make();await pool.query('INSERT INTO billing_subscription_runtime(subscription_id,revoked_at) VALUES($1,now())',[revoked.period]);await denied(lab.authenticate(request(revoked)));
    const reset=await make();const rotated=await generateServiceCredentials(reset.id,{version:3,reason:'Fixture reset',request_key:randomUUID()},'fixture');passwords.push(rotated.password);await denied(lab.authenticate(request(reset)));await lab.authenticate(request({...reset,password:rotated.password}));
    const sibling=await make('free',{customer:reset.customer});await denied(lab.authenticate(request(sibling)));
    now=new Date('2026-01-31T10:00:00Z');const month=await make('free',{packageId:2});const monthReply=await lab.authenticate(request(month));const monthSession=randomUUID();await lab.accounting(account(month,monthReply,'Start',monthSession));const monthTimes=await ready(admissionId(monthReply),monthSession,3);assert.equal(monthTimes.expires_at.toISOString(),'2026-02-28T10:00:00.000Z');
    await assert.rejects(pool.query("UPDATE billing_subscriptions SET status='active',activation_at=now(),expires_at=now()+interval '1 day' WHERE id=$1",[month.period]),e=>e.code==='23514');
    assert.equal((await pool.query('SELECT count(*)::int n FROM billing_subscriptions WHERE activation_at IS NOT NULL')).rows[0].n,0);
    const diagnostic=JSON.stringify((await pool.query('SELECT * FROM pppoe_lab_admissions')).rows);assert.ok(passwords.every(p=>!diagnostic.includes(p)));
    console.log('PASS: lost Start remains blocked until explicit never-enabled proof, stale open sessions retain capacity, revoked grants, password reset, cross-service limits, calendar clamping and unchanged production activation guards');
    await require('/app/check-pppoe-provisioning.cjs')({pool,lab,make,request,account,denied,getNow:()=>new Date(now),setNow:value=>{now=value;},schema});
    if(!process.argv.includes('--serve'))return;

    now=new Date();const wires=[];for(const kind of ['paid','free'])for(const method of ['pap','chap'])wires.push(await make(kind,{username:'wire-'+kind+'-'+method}));
    const wireUnpaid=await make('unpaid',{username:'wire-unpaid'});const wireSuspended=await make('free',{username:'wire-suspended'});await controlState(wireSuspended,'suspended');
    const wireExpired=await make('free',{username:'wire-expired'});await pool.query('INSERT INTO pppoe_lab_periods(subscription_id,service_id,activation_at,expires_at) VALUES($1,$2,$3,$4)',[wireExpired.period,wireExpired.id,new Date(now.getTime()-7200000),new Date(now.getTime()-3600000)]);
    const token=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex');
    let finish;const done=new Promise(resolve=>finish=resolve);const express=require('express');require('express-async-errors');const app=express();app.use(express.json({limit:'16kb'}));
    app.use((req,res,next)=>{res.set('Cache-Control','no-store');const supplied=Buffer.from(req.get('X-PPPoE-Lab-Token')??''),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){console.error('LAB HTTP TOKEN REFUSED',req.path);return res.sendStatus(401);}next();});
    app.post('/authenticate',async(req,res)=>{now=new Date();const values=await lab.authenticate(req.body);res.json(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value:[value],op:':=',do_xlat:false,is_json:false}])));});
    app.post('/accounting',async(req,res)=>{now=new Date();await lab.accounting(req.body);res.sendStatus(204);});
    app.post('/done',async(_req,res)=>{const rows=(await pool.query("SELECT a.* FROM pppoe_lab_admissions a JOIN billing_customer_services s ON s.id=a.service_id WHERE s.username LIKE 'wire-%'")).rows;assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.state==='stopped').length,1);const row=rows.find(r=>r.state==='stopped');assert.equal((await pool.query('SELECT activation_at FROM pppoe_lab_periods WHERE subscription_id=$1',[row.subscription_id])).rows[0].activation_at,null);await ready(row.id,row.session_key,3);assert.equal(Number(row.download_bytes),90000);assert.equal(Number(row.upload_bytes),20000);res.sendStatus(204);setTimeout(finish,250);});
    app.use((e,_req,res,_next)=>{console.error('LAB REQUEST REFUSED',e.status??503,e.status?e.message:'Internal lab error');res.status(e.status??503).json({error:'Lab request refused'});});
    server=app.listen(3009,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const lines=['export PPPOE_DB_LAB_TOKEN='+token,'export RADIUS_LAB_SECRET='+secret];for(const f of [...wires,wireUnpaid,wireSuspended,wireExpired])lines.push('export '+f.username.replace(/-/g,'_').toUpperCase()+'_PASSWORD='+f.password);
    await fs.writeFile('/lab/fixture.env',lines.join('\n')+'\n',{mode:0o640});console.log('READY: private saved-credential RADIUS protocol fixture');
    const stop=()=>finish(new Error('Protocol fixture stopped'));process.once('SIGTERM',stop);
    const timeout=setTimeout(()=>finish(new Error('Protocol fixture timed out')),300000);try{const result=await done;if(result instanceof Error)throw result;}finally{clearTimeout(timeout);process.off('SIGTERM',stop);}
    console.log('PASS: real FreeRADIUS PAP/CHAP reached saved encrypted credentials and billing policy; correlated accounting persisted before ACK and readiness remained separate');
  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await control.end();
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
