// Real SQL, fictional records, disposable schema. No provider/router calls.
const assert=require('node:assert/strict'),{Pool}=require('pg'),{randomUUID}=require('node:crypto');
async function main(){
 const schema='fup_lab_'+randomUUID().replace(/-/g,'');
 const url=new URL(process.env.DATABASE_URL);if(process.env.DB_PASSWORD)url.password=encodeURIComponent(process.env.DB_PASSWORD);
 const control=new Pool({connectionString:url.toString(),options:'-c search_path=public'});let pool;
 try{
 await control.query('CREATE SCHEMA "'+schema+'"');
 const tables=(await control.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'billing_%' ORDER BY tablename")).rows;
 for(const {tablename} of tables){assert.match(tablename,/^[a-z0-9_]+$/);await control.query('CREATE TABLE "'+schema+'"."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING ALL)');}
 process.env.PGOPTIONS='-c search_path='+schema;
 ({pool}=require('/app/dist/config/database'));
 const {FUP_SCHEMA,saveCustomerFup,customerFup,fupWindow}=require('/app/dist/modules/billing/fupSettings');await pool.query(FUP_SCHEMA);
 const {parseFup,evaluateFup}=require('/app/dist/modules/billing/fup');
 const policy=parseFup({version:1,direction:'combined',reset:'monthly',timezone:'Africa/Nairobi',warning_percent:80,tiers:[{threshold_bytes:100e9,action:'throttle',download_bps:5e6,upload_bps:2e6},{threshold_bytes:200e9,action:'block'}]});
 const c=(await pool.query("INSERT INTO billing_customers(full_name) VALUES('FUP fictional') RETURNING id")).rows[0].id;
 const offer=(await pool.query("INSERT INTO billing_packages(name,amount_minor,duration_value,duration_unit,download_bps,upload_bps,fup_policy) VALUES('FUP fictional',1000,1,'day',20000000,5000000,$1) RETURNING *",[JSON.stringify(policy)])).rows[0];
 const {parseGrant,grantComplimentary}=require('/app/dist/modules/billing/customerAccess');
 const grant=await grantComplimentary(parseGrant({package_id:offer.id,package_version:offer.version,reason:'Fixture complimentary access',request_key:randomUUID(),confirm_complimentary:true},c),'fixture');
 const snapshot=(await pool.query('SELECT package_snapshot FROM billing_access_grants WHERE id=$1',[grant.id])).rows[0].package_snapshot;
 assert.deepEqual(snapshot.fup_policy,policy);
 await pool.query('UPDATE billing_packages SET fup_policy=NULL,version=version+1 WHERE id=$1',[offer.id]);
 let r=await customerFup(c);assert.deepEqual(r.periods[0].policy,policy);assert.equal(r.periods[0].usage_bytes,null);
 console.log('PASS: package policy copied into immutable purchased terms; package edits do not rewrite existing entitlements');
 r=await saveCustomerFup(c,{mode:'exempt',version:0,reason:'Fixture exemption',expires_at:'2099-01-01T00:00:00Z'},'fixture');assert.equal(r.effective_mode,'exempt');assert.equal(r.periods[0].policy,null);
 await assert.rejects(saveCustomerFup(c,{mode:'inherit',version:0,reason:'Stale edit'},'fixture'),{status:409});
 await pool.query("UPDATE billing_customer_fup SET expires_at='2020-01-01' WHERE customer_id=$1",[c]);r=await customerFup(c);assert.equal(r.effective_mode,'inherit');assert.deepEqual(r.periods[0].policy,policy);
 r=await saveCustomerFup(c,{mode:'custom',version:1,reason:'Fixture custom',policy:{...policy,direction:'download'}},'fixture');assert.equal(r.periods[0].policy.direction,'download');
 const events=await pool.query("SELECT count(*)::int AS n FROM billing_management_events WHERE customer_id=$1 AND kind='fup_policy_changed'",[c]);assert.equal(events.rows[0].n,2);
 console.log('PASS: exemption, expiry fallback, custom policy, optimistic locking and audit history');
 const daily={...policy,reset:'daily',timezone:'America/New_York'};
 const spring=await fupWindow(daily,'2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','2026-03-08T12:00:00Z');assert.equal((new Date(spring.end)-new Date(spring.start))/36e5,23);
 const autumn=await fupWindow(daily,'2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','2026-11-01T12:00:00Z');assert.equal((new Date(autumn.end)-new Date(autumn.start))/36e5,25);
 const clipped=await fupWindow({...policy,reset:'monthly'},'2026-10-18T10:00:00Z','2026-10-19T10:00:00Z','2026-10-18T12:00:00Z');assert.equal(new Date(clipped.start).toISOString(),'2026-10-18T10:00:00.000Z');assert.equal(new Date(clipped.end).toISOString(),'2026-10-19T10:00:00.000Z');
 console.log('PASS: timezone-aware 23/25-hour DST resets and calendar windows clipped to confirmed entitlement');
 assert.equal(evaluateFup(policy,{download_bytes:90e9,upload_bytes:10e9},{download_bps:20e6,upload_bps:1e6,allowance_bytes:null,access_allowed:true}).upload_bps,1e6);
 assert.equal(evaluateFup(null,{download_bytes:0,upload_bytes:0,lifetime_total_bytes:300e9},{download_bps:20e6,upload_bps:1e6,allowance_bytes:300e9,access_allowed:true}).state,'blocked');
 console.log('PASS: customer speed ceiling and lifetime hard cap remain authoritative');
 }finally{if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await control.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
