// All fixtures live in a disposable schema, never in public customer tables.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');

async function main() {
  const schema = `pppoe_foundation_${randomUUID().replace(/-/g,'')}`;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.SECRETS_DIR = `/tmp/${schema}_keys`;
  assert.match(schema,/^pppoe_foundation_[a-f0-9]{32}$/);
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.DB_PASSWORD) url.password = encodeURIComponent(process.env.DB_PASSWORD);
  const control = new Pool({ connectionString: url.toString(),options: '-c search_path=public' });
  let pool;
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    ({ pool } = require('/app/dist/config/database'));
    assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s,schema);
    await pool.query('CREATE TABLE devices(id INTEGER PRIMARY KEY,name TEXT)');
    for (const [file,key] of [['packages','PACKAGE_SCHEMA'],['customersPayments','CUSTOMERS_PAYMENTS_SCHEMA'],['subscriptions','SUBSCRIPTIONS_SCHEMA'],['customerAccess','CUSTOMER_ACCESS_SCHEMA'],['sessions','SESSIONS_SCHEMA'],['accessManagementSchema','ACCESS_MANAGEMENT_SCHEMA']]) {
      await pool.query(require(`/app/dist/modules/billing/${file}`)[key]);
    }
    await pool.query("INSERT INTO billing_customers(full_name) VALUES('Customer A'),('Customer B')");
    await pool.query("INSERT INTO billing_packages(name,amount_minor,duration_value,duration_unit,download_bps,upload_bps) VALUES('Test offer',1000,1,'day',5000000,2000000)");
    const makePeriod = async (customerId,mode = 'live',complimentary = false) => {
      const funding = randomUUID(),subscription = randomUUID(),account = randomUUID();
      const snapshot = JSON.stringify({ name: 'Original terms',duration_value: 1,duration_unit: 'day',download_bps: 5000000,upload_bps: 2000000 });
      if (complimentary) await pool.query(`INSERT INTO billing_access_grants(id,reference,request_key,request_payload,customer_id,package_id,package_snapshot,reason,actor)
        VALUES($1,$2,$3,'{}',$4,1,$5,'Test grant','fixture')`,[funding,`G-${funding}`,randomUUID(),customerId,snapshot]);
      else await pool.query(`INSERT INTO billing_purchases(id,reference,request_key,customer_id,package_id,payer_phone,amount_minor,currency,package_snapshot)
        VALUES($1,$2,$3,$4,1,'+254700000000',1000,'KES',$5)`,[funding,funding.slice(0,32),randomUUID(),customerId,snapshot]);
      await pool.query(`INSERT INTO billing_subscriptions(id,${complimentary ? 'grant_id' : 'purchase_id'},mode,status) VALUES($1,$2,$3,'pending_activation')`,[subscription,funding,mode]);
      await pool.query('INSERT INTO billing_access_accounts(id,subscription_id,username) VALUES($1,$2,$3)',[account,subscription,`acct_${account.replace(/-/g,'')}`]);
      return { subscription,account };
    };
    const paid = await makePeriod(1), grant = await makePeriod(1,'simulation',true), other = await makePeriod(2);
    await pool.query("UPDATE billing_subscriptions SET status='active',activation_at='2026-01-01T00:00:00Z',expires_at='2026-01-02T00:00:00Z' WHERE id=$1",[grant.subscription]);
    await pool.query(`INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at,ended_at,end_reason,download_bytes,upload_bytes)
      VALUES($1,$2,'simulation','192.0.2.10','02:00:00:00:00:01','Historical lab router','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','2026-01-01T01:00:00Z','test_stopped',4096,1024)`,[randomUUID(),grant.account]);
    const before = {};
    for (const table of ['billing_customers','billing_purchases','billing_access_grants','billing_subscriptions','billing_access_accounts','billing_sessions']) before[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    const { migrateCustomerServices } = require('/app/dist/modules/billing/customerServicesSchema');
    const migrate = async () => { const client = await pool.connect(); try { await migrateCustomerServices(client); } finally { client.release(); } };
    await migrate(); await migrate();
    for (const [table,rows] of Object.entries(before)) {
      const actual=(await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      assert.deepEqual(actual.map(row=>Object.fromEntries(Object.keys(rows[0] ?? {}).map(key=>[key,row[key]]))),rows,table);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_customer_services')).rows[0].n,3);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_service_periods')).rows[0].n,3);
    assert.deepEqual((await pool.query('SELECT service_types FROM billing_packages WHERE id=1')).rows[0].service_types,['hotspot']);
    console.log('PASS: repeat migration preserves legacy identities, purchase/grant terms, timestamps and live/simulation separation');

    const { createServiceDraft, listCustomerServices } = require('/app/dist/modules/billing/customerServices');
    const input = { customer_id: 1,username: null,label: 'Home PPPoE',reason: 'Foundation fixture',request_key: randomUUID() };
    const attempts = await Promise.all(Array.from({ length: 6 },() => createServiceDraft(input,'fixture')));
    assert.equal(attempts.filter((r) => !r.replayed).length,1);
    assert.equal(new Set(attempts.map((r) => r.service.id)).size,1);
    const service = attempts[0].service;
    assert.match(service.username,/^ppp_[a-f0-9]{32}$/); assert.equal(service.state,'draft');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_management_events WHERE kind='pppoe_service_prepared'")).rows[0].n,1);
    assert.ok((await listCustomerServices(1)).some((s) => s.id===service.id));
    assert.equal(JSON.stringify(service).includes('request_payload'),false);
    await assert.rejects(createServiceDraft({ ...input,label: 'Changed' },'fixture'),(e) => e.status===409);
    await assert.rejects(createServiceDraft({ ...input,customer_id: 2 },'fixture'),(e) => e.status===409);
    await assert.rejects(createServiceDraft({ ...input,request_key: randomUUID(),username: service.username },'fixture'),(e) => e.status===409);
    await assert.rejects(createServiceDraft({ ...input,customer_id: 99999,request_key: randomUUID() },'fixture'),(e) => e.status===404);
    console.log('PASS: concurrent/replayed draft creation keeps one login and one audit event; conflicts and missing customers rejected');

    const reject = (sql,args = []) => assert.rejects(pool.query(sql,args),(e) => e.code==='23514');
    await reject('UPDATE billing_customer_services SET customer_id=2 WHERE id=$1',[service.id]);
    await reject("UPDATE billing_customer_services SET username='replaced' WHERE id=$1",[service.id]);
    await reject("UPDATE billing_customer_services SET state='active' WHERE id=$1",[service.id]);
    await reject('DELETE FROM billing_customer_services WHERE id=$1',[service.id]);
    await reject('DELETE FROM billing_service_periods WHERE subscription_id=$1',[paid.subscription]);
    await reject("UPDATE billing_customer_services SET request_payload=NULL WHERE id=$1",[service.id]);
    await reject("UPDATE billing_packages SET service_types=ARRAY['pppoe','hotspot'] WHERE id=1");
    await reject("UPDATE billing_packages SET service_types=ARRAY[]::text[] WHERE id=1");
    await reject('UPDATE billing_service_periods SET service_id=$1 WHERE subscription_id=$2',[other.account,paid.subscription]);
    await reject('INSERT INTO billing_service_periods(service_id,subscription_id) VALUES($1,$2)',[paid.account,randomUUID()]);
    // Unassigned periods exercise customer/mode checks before PPPoE's release gate.
    const extra = await makePeriod(1), crossCustomer = await makePeriod(2), crossMode = await makePeriod(1,'simulation');
    await reject(`INSERT INTO billing_customer_services(id,customer_id,service_type,mode,username,label,state,legacy_account_id)
      SELECT $1,2,'hotspot','live',username,'Wrong customer','legacy',id FROM billing_access_accounts WHERE id=$2`,[randomUUID(),extra.account]);
    await reject('INSERT INTO billing_service_periods(service_id,subscription_id) VALUES($1,$2)',[service.id,crossCustomer.subscription]);
    await reject('INSERT INTO billing_service_periods(service_id,subscription_id) VALUES($1,$2)',[service.id,crossMode.subscription]);
    await reject('INSERT INTO billing_service_periods(service_id,subscription_id) VALUES($1,$2)',[service.id,extra.subscription]);
    await reject('UPDATE billing_access_accounts SET credentials_issued=true WHERE id=$1',[paid.account]);
    await reject("UPDATE billing_subscriptions SET status='active',activation_at=now(),expires_at=now()+interval '1 day' WHERE id=$1",[paid.subscription]);
    await migrate();
    assert.equal((await pool.query('SELECT * FROM billing_customer_services WHERE id=$1',[service.id])).rows[0].username,service.username);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_service_periods')).rows[0].n,6);
    console.log('PASS: immutable ownership, legacy mapping, eligibility constraints and live-access gates; later legacy accounts adopted safely');

    // A failed migration must roll back every new mapping and release its lock.
    const unadopted = await makePeriod(1), collision = await makePeriod(1);
    const originalName = (await pool.query('SELECT username FROM billing_access_accounts WHERE id=$1',[paid.account])).rows[0].username;
    await pool.query('UPDATE billing_access_accounts SET username=$1 WHERE id=$2',[originalName.toUpperCase(),collision.account]);
    const mappingsBefore = (await pool.query('SELECT * FROM billing_customer_services ORDER BY id')).rows;
    await assert.rejects(migrate(),(e) => e.code==='23505');
    assert.deepEqual((await pool.query('SELECT * FROM billing_customer_services ORDER BY id')).rows,mappingsBefore);
    await pool.query('UPDATE billing_access_accounts SET username=$1 WHERE id=$2',[`acct_${collision.account.replace(/-/g,'')}`,collision.account]);
    await migrate();
    assert.equal((await pool.query('SELECT service_id FROM billing_service_periods WHERE subscription_id=$1',[unadopted.subscription])).rows[0].service_id,unadopted.account);
    console.log('PASS: migration failure is atomic and repeatable after resolving a legacy username collision');

    const { generateServiceCredentials } = require('/app/dist/modules/billing/serviceCredentials');
    const { decrypt } = require('/app/dist/utils/crypto');
    const credentialInput = { version: 1,reason: 'Initial password fixture',request_key: randomUUID() };
    const issued = await Promise.all(Array.from({ length: 6 },() => generateServiceCredentials(service.id,credentialInput,'fixture')));
    assert.equal(issued.filter((r) => r.password!==null).length,1);
    assert.equal(issued.filter((r) => !r.replayed).length,1);
    const first = issued.find((r) => r.password!==null);
    assert.match(first.password,/^[a-zA-Z0-9_-]{24}$/);
    let stored = (await pool.query('SELECT * FROM billing_service_credentials WHERE service_id=$1',[service.id])).rows[0];
    assert.equal(decrypt(stored.password_encrypted),first.password);
    assert.equal(stored.password_encrypted.includes(first.password),false);
    assert.equal(first.service.version,2); assert.equal(first.service.credential_revision,1);
    assert.equal(JSON.stringify(await listCustomerServices(1)).includes(first.password),false);
    assert.equal(JSON.stringify(await listCustomerServices(1)).includes(stored.password_encrypted),false);
    await assert.rejects(generateServiceCredentials(service.id,{ ...credentialInput,request_key: randomUUID() },'fixture'),(e) => e.status===409);
    await assert.rejects(generateServiceCredentials(paid.account,credentialInput,'fixture'),(e) => e.status===409);
    await assert.rejects(generateServiceCredentials(service.id,{ ...credentialInput,reason: 'Changed replay' },'fixture'),(e) => e.status===409);
    const resetInput = { version: 2,reason: 'Password reset fixture',request_key: randomUUID() };
    const reset = await generateServiceCredentials(service.id,resetInput,'fixture');
    stored = (await pool.query('SELECT * FROM billing_service_credentials WHERE service_id=$1',[service.id])).rows[0];
    assert.notEqual(reset.password,first.password); assert.equal(reset.service.username,service.username);
    assert.equal(stored.revision,2); assert.equal(decrypt(stored.password_encrypted),reset.password);
    assert.equal((await generateServiceCredentials(service.id,credentialInput,'fixture')).password,null);
    assert.equal((await pool.query('SELECT revision FROM billing_service_credentials WHERE service_id=$1',[service.id])).rows[0].revision,2);
    const events = JSON.stringify((await pool.query('SELECT * FROM billing_management_events')).rows);
    const requests = JSON.stringify((await pool.query('SELECT * FROM billing_service_credential_requests')).rows);
    assert.ok(!events.includes(first.password) && !events.includes(reset.password));
    assert.ok(!requests.includes(first.password) && !requests.includes(reset.password));
    await migrate();
    assert.equal(decrypt((await pool.query('SELECT password_encrypted FROM billing_service_credentials WHERE service_id=$1',[service.id])).rows[0].password_encrypted),reset.password);
    console.log('PASS: encrypted one-time password issuance, duplicate-safe reset, stable login, no secret in summaries/audit/replay, migration preserves credentials');
    await require('/app/check-pppoe-funding.cjs')(pool,service.id);
    await require('/app/check-pppoe-bindings.cjs')(pool,service.id);
  } finally {
    if (pool) await pool.end();
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
