// Disposable schema and fictional records only; no model/provider calls.
const assert=require('node:assert/strict');
const {Pool}=require('pg');const {randomUUID,randomBytes}=require('node:crypto');
async function main(){
  const schema='ai_tools_lab_'+randomUUID().replace(/-/g,'');
  process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.SECRETS_DIR='/tmp/'+schema;
  const url=new URL(process.env.DATABASE_URL);if(process.env.DB_PASSWORD)url.password=encodeURIComponent(process.env.DB_PASSWORD);
  const control=new Pool({connectionString:url.toString(),options:'-c search_path=public'});let pool;
  try{
    await control.query('CREATE SCHEMA "'+schema+'"');
    const tables=(await control.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'billing_%' OR tablename IN ('devices','interfaces')) ORDER BY tablename")).rows;
    for(const {tablename} of tables){assert.match(tablename,/^[a-z0-9_]+$/);await control.query('CREATE TABLE "'+schema+'"."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING ALL)');}
    process.env.PGOPTIONS='-c search_path='+schema;
    ({pool}=require('/app/dist/config/database'));
    await pool.query(require('/app/dist/modules/billing/fupSettings').FUP_SCHEMA);
    await pool.query(require('/app/dist/modules/billing/networkPipelineSchema').NETWORK_PIPELINE_SCHEMA);
    await pool.query("INSERT INTO billing_customers(id,full_name,phone,notes) VALUES(1,'Fictional Customer',NULL,'NEVER EXPOSE THIS NOTE'),(2,'No service customer',NULL,'')");
    await pool.query("INSERT INTO billing_packages(id,name,amount_minor,currency,duration_value,duration_unit,download_bps,upload_bps,service_types) VALUES(1,'Fictional Package',1000,'KES',1,'day',5000000,2000000,ARRAY['hotspot','pppoe'])");
    await pool.query("INSERT INTO billing_customer_controls(customer_id,desired_state,version,reason,actor) VALUES(1,'vacation',1,'PRIVATE AUDIT REASON','fixture')");
    const purchase=randomUUID();
    await pool.query("INSERT INTO billing_purchases(id,reference,request_key,customer_id,package_id,payer_phone,amount_minor,currency,package_snapshot,payment_status) VALUES($1,'TEST-TOOLS',$2,1,1,'+254700000000',1000,'KES','{}','paid')",[purchase,randomUUID()]);
    await pool.query("INSERT INTO billing_payment_receipts(id,purchase_id,request_key,method,amount_minor,reference,paid_at,actor,notes,fingerprint) VALUES($1,$2,$3,'cash',1000,'',now(),'fixture','PRIVATE RECEIPT NOTE','fixture')",[randomUUID(),purchase,randomUUID()]);
    await pool.query("INSERT INTO devices(id,name,ip_address,api_username,api_password_encrypted) VALUES(2147000000,'Fictional metric target','192.0.2.1','fixture','PRIVATE-UNUSED-CREDENTIAL')");
    await pool.query("INSERT INTO interfaces(id,device_id,name,type,running) VALUES(2147000000,2147000000,'fixture-uplink','ether',true)");
    let audits=0;const tools=require('/app/dist/modules/ai/chatTools').chatTools(async()=>{},async()=>{audits++;});assert.equal(Object.keys(tools).length,10);
    async function run(name,args){const t=tools[name];const r=await t.execute(t.inputSchema.parse(args),{toolCallId:randomUUID(),messages:[]});assert.equal(r.ok,true,name+' failed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('NEVER EXPOSE'));return r.data;}
    // Every set shares a ten-call cap, just like a single model run.
    const summary=await run('listCustomers',{view:'summary'});assert.equal(summary.summary.total_customers,2);assert.equal(summary.summary.requested_vacation,1);assert.equal(summary.live_online_customers,null);
    const directory=await run('listCustomers',{limit:1});assert.equal(directory.items.length,1);assert.equal(directory.has_more,true);
    assert.equal((await run('listCustomers',{offset:1,limit:1})).items[0].id,2);
    assert.equal((await run('listPackages',{})).items[0].amount_minor,1000);
    const today=new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Nairobi'});
    const payments=await run('listPayments',{start:today,end:today});assert.equal(payments.items.length,1);assert.equal(payments.items[0].confirmed_receipt,true);assert.equal(payments.items[0].method,'cash');
    assert.equal((await run('listPayments',{start:today,end:today})).items.length,1);
    await run('getCustomerAccess',{customerId:1,view:'services'});await run('getCustomerAccess',{customerId:1,view:'subscriptions'});await run('listCustomerSessions',{customerId:1});await run('getCustomerAccess',{customerId:1,view:'devices'});
    const more=require('/app/dist/modules/ai/chatTools').chatTools(async()=>{},async()=>{audits++;});
    async function check(name,args){const t=more[name];const r=await t.execute(t.inputSchema.parse(args),{toolCallId:randomUUID(),messages:[]});assert.equal(r.ok,true,name+' failed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));return r.data;}
    assert.equal((await check('getCustomerAccess',{customerId:1,view:'schedule'})).requested_state,'vacation');await check('listAccessAlerts',{});await check('listProvisioningJobs',{});await check('getCustomerAccess',{customerId:1,view:'history'});await check('listExpiringSubscriptions',{});await check('getRouterStatus',{});await check('listCustomers',{search:'Fictional'});await check('getCustomerAccess',{customerId:1});await check('getBillingSummary',{start:today,end:today});
    const metrics=require('/app/dist/modules/ai/chatTools').chatTools(async()=>{},async()=>{audits++;});
    const listed=await metrics.getRouterStatus.execute(metrics.getRouterStatus.inputSchema.parse({view:'interfaces',deviceId:2147000000}),{toolCallId:randomUUID(),messages:[]});assert.equal(listed.ok,true);assert.equal(listed.data.items[0].name,'fixture-uplink');
    const bandwidth=await metrics.getRouterStatus.execute(metrics.getRouterStatus.inputSchema.parse({view:'bandwidth',deviceId:2147000000,interfaceName:'fixture-uplink'}),{toolCallId:randomUUID(),messages:[]});assert.equal(bandwidth.ok,true,'Influx query must execute');assert.equal(bandwidth.data.receive.bps,null);assert.equal(bandwidth.data.receive.reason,'insufficient_samples');assert.ok(!JSON.stringify(bandwidth).includes('PRIVATE'));
    assert.equal(audits,21);console.log('PASS: 10 consolidated tools across 21 bounded calls preserving all prior sections; exact customer count including no-service customer, directory pagination, verified cash receipt, SQL execution, safe projections, bounded empty Influx bandwidth query and audit coverage');
    const filterTools=require('/app/dist/modules/ai/chatTools').chatTools(async()=>{},async()=>{});
    async function filtered(name,args){const t=filterTools[name],r=await t.execute(t.inputSchema.parse(args),{toolCallId:randomUUID(),messages:[],context:{}});assert.equal(r.ok,true,name+' filtered query failed');return r.data;}
    const vacation=await filtered('listCustomers',{view:'summary',requestedState:'vacation'});assert.equal(vacation.summary.total_customers,1);
    const none=await filtered('listCustomers',{view:'summary',search:'NO MATCH'});assert.equal(none.summary.total_customers,0);
    const empty=await filtered('listCustomerSessions',{});assert.equal(empty.summary.total,0);assert.equal(empty.items.length,0);
    const sub=randomUUID(),account=randomUUID();
    await pool.query("INSERT INTO billing_subscriptions(id,purchase_id,mode,status,activation_at,expires_at) VALUES($1,$2,'simulation','active','2026-10-01T00:00:00Z','2026-12-01T00:00:00Z')",[sub,purchase]);
    await pool.query("INSERT INTO billing_access_accounts(id,subscription_id,username) VALUES($1,$2,'fixture_account')",[account,sub]);
    for(const [started,bytes] of [['2026-10-01T22:00:00Z',100],['2026-10-02T22:00:00Z',900]])await pool.query("INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at,ended_at,end_reason,download_bytes) VALUES($1,$2,'simulation','192.0.2.2','00:11:22:33:44:55','Fictional',$3,$3::timestamptz+interval '1 hour',$3::timestamptz+interval '1 hour','test_stopped',$4)",[randomUUID(),account,started,bytes]);
    // Nairobi is UTC+3: the first record started on October 2 locally, the second on October 3.
    const day=await filtered('listCustomerSessions',{view:'summary',customerId:1,start:'2026-10-02',end:'2026-10-02'});assert.equal(day.summary.total,1);assert.equal(day.summary.download_bytes,100);
    const usage=await filtered('listCustomerSessions',{customerId:1,sort:'total_usage',limit:1});assert.equal(usage.items[0].download_bytes,900);assert.equal(usage.has_more,true);assert.equal(usage.summary.total,2);
    const pppoe=await filtered('listCustomerSessions',{view:'summary',customerId:1,connectionType:'pppoe'});assert.equal(pppoe.summary.total,0);
    console.log('PASS: filtered customer totals, shared saved-session dataset, Nairobi session-start dates, usage ordering, shared summary/list filters and pagination');
  }finally{if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await control.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
