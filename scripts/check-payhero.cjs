// Runs inside the backend container against a disposable PostgreSQL schema.
// All provider transport is injected and simulated. Never calls a payment rail.
const assert = require('node:assert/strict');
const { randomUUID,randomBytes } = require('node:crypto');
const { mkdir,rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
async function main() {
  const suffix = randomUUID().replace(/-/g,''), schema = `payhero_test_${suffix}`;
  assert.match(schema,/^payhero_test_[a-f0-9]{32}$/);
  const u = new URL(process.env.DATABASE_URL); if (process.env.DB_PASSWORD) u.password = encodeURIComponent(process.env.DB_PASSWORD);
  const control = new Pool({ connectionString: u.toString(),options: '-c search_path=public' });
  const originalPointer = (await control.query('SELECT * FROM billing_payhero_settings')).rows;
  const secretDir = path.join(tmpdir(),`payhero-test-${suffix}`);
  await mkdir(secretDir);
  let pool;
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.SECRETS_DIR = secretDir;
    process.env.NODE_ENV = 'test';
    ({ pool } = require('/app/dist/config/database'));
    assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s,schema,'Refuse to test outside the disposable schema');
    for (const table of ['billing_customers','billing_packages','billing_purchases','billing_subscriptions','billing_access_accounts','billing_access_events','billing_access_jobs','billing_portals']) await pool.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    const { PAYHERO_SCHEMA } = require('/app/dist/modules/billing/payheroSchema');
    await pool.query(PAYHERO_SCHEMA);
    const service = require('/app/dist/modules/billing/payhero');
    const { initSecrets } = require('/app/dist/utils/secrets'); initSecrets();
    const { decrypt } = require('/app/dist/utils/crypto');
    const offer = (await pool.query(`INSERT INTO billing_packages(name,amount_minor,currency,duration_value,duration_unit,download_bps,upload_bps,allowance_bytes,enabled) VALUES('PayHero fixture',5000,'KES',1,'day',5000000,2000000,NULL,true) RETURNING *`)).rows[0];
    const { portalTemplates } = require('/app/dist/modules/billing/portals');
    const config = { ...portalTemplates[0].default_config,package_ids: [offer.id] };
    await pool.query(`INSERT INTO billing_portals(name,slug,draft_config,published_config,published_version,published_at,actor) VALUES('Fixture','fixture',$1,$1,1,now(),'fixture')`,[JSON.stringify(config)]);
    const settingsInput = { version: 0,enabled: true,mode: 'sandbox',base_url: 'https://backend.payhero.co.ke',channel_id: 133,account_id: null,public_origin: 'https://billing.example.test',username: 'fixture-api',password: 'fixture-secret' };
    let settings = await service.savePayHeroSettings(settingsInput,'fixture');
    assert.ok(!JSON.stringify(settings).includes('fixture-secret')); assert.ok(settings.credentials_configured);
    const encrypted = (await pool.query('SELECT credentials_encrypted FROM billing_payhero_configs WHERE id=$1',[settings.id])).rows[0].credentials_encrypted;
    assert.ok(!encrypted.includes('fixture-secret')); assert.equal(JSON.parse(decrypt(encrypted)).username,'fixture-api');
    await assert.rejects(service.savePayHeroSettings({ ...settingsInput,version: settings.version,mode: 'live',username: '',password: '' },'fixture'));
    const requests = new Map(), states = new Map(); let posts = 0, timeoutNext = false;
    const transport = async (url,options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin,'https://backend.payhero.co.ke'); assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,`Basic ${Buffer.from('fixture-api:fixture-secret').toString('base64')}`);
      if (parsed.pathname.endsWith('/payment_channels')) return new Response(JSON.stringify({ payment_channels: [{ id: 133,is_active: true,channel_type: 'till' }] }));
      if (options.method === 'POST') {
        posts++; const body = JSON.parse(options.body); assert.equal(body.amount,50); assert.equal(body.provider,'m-pesa');
        const record = { body,reference: `provider-${body.external_reference}`,checkout: `checkout-${body.external_reference}`,receipt: `R${randomUUID().replace(/-/g,'').slice(0,15)}` };
        requests.set(body.external_reference,record); states.set(record.reference,'QUEUED');
        if (timeoutNext) { timeoutNext = false; throw new Error('Simulated lost initiation reply'); }
        return new Response(JSON.stringify({ success: true,status: 'QUEUED',reference: record.reference,CheckoutRequestID: record.checkout }),{ status: 201 });
      }
      const ref = parsed.searchParams.get('reference');
      const record = [...requests.values()].find((row) => row.reference === ref || row.receipt === ref); assert.ok(record,'Only saved provider references or scoped receipt recovery can be queried');
      return new Response(JSON.stringify({ reference: record.reference,CheckoutRequestID: record.checkout,provider: 'm-pesa',success: states.get(record.reference) === 'SUCCESS',status: states.get(record.reference),provider_reference: record.receipt }));
    };
    assert.equal((await service.testPayHeroConnection(transport)).channel_active,true); assert.equal(posts,0);
    const due = async (id) => pool.query('UPDATE billing_payhero_attempts SET next_check_at=now(),locked_until=NULL WHERE id=$1',[id]);
    const attemptFor = async (purchaseId) => (await pool.query('SELECT * FROM billing_payhero_attempts WHERE purchase_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[purchaseId])).rows[0];
    const make = async (phone) => {
      const body = { mode: settings.mode,package_id: offer.id,package_version: offer.version,payer_phone: phone,request_key: randomUUID(),checkout_token: randomBytes(32).toString('hex') };
      const checkout = await service.publicCheckout('fixture',body); return { body,checkout,attempt: await attemptFor(checkout.id) };
    };
    const notify = async (a,changes = {}) => {
      const record = requests.get(a.external_reference); assert.ok(record);
      const secret = new URL(record.body.callback_url).pathname.split('/').pop();
      const body = { response: { Amount: 50,ExternalReference: a.external_reference,CheckoutRequestID: record.checkout,MpesaReceiptNumber: record.receipt,Phone: record.body.phone_number,ResultCode: 0,...changes } };
      await service.receivePayHeroCallback(a.id,secret,body); return { secret,body,record };
    };
    const first = await make('0712345678');
    assert.equal(posts,0);
    assert.equal((await service.publicCheckout('fixture',first.body)).id,first.checkout.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_customers')).rows[0].n,1);
    await assert.rejects(service.publicCheckoutStatus(first.checkout.id,'0'.repeat(64)));
    await service.processPayHeroAttempt(first.attempt.id,transport); assert.equal(posts,1);
    await due(first.attempt.id); await service.processPayHeroAttempt(first.attempt.id,transport);
    assert.equal((await attemptFor(first.checkout.id)).state,'pending');
    await assert.rejects(service.receivePayHeroCallback(first.attempt.id,'0'.repeat(64),{}));
    const notification = await notify(first.attempt);
    await service.receivePayHeroCallback(first.attempt.id,notification.secret,notification.body);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_payhero_callbacks')).rows[0].n,1);
    states.set(notification.record.reference,'SUCCESS');
    await due(first.attempt.id); await service.processPayHeroAttempt(first.attempt.id,transport);
    assert.equal((await attemptFor(first.checkout.id)).state,'succeeded');
    assert.equal((await pool.query('SELECT payment_status FROM billing_purchases WHERE id=$1',[first.checkout.id])).rows[0].payment_status,'pending');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_subscriptions')).rows[0].n,0);
    assert.ok(!JSON.stringify(await service.adminPaymentDetail(first.checkout.id)).includes(notification.secret));
    console.log('PASS: encrypted/masked settings, channel check, idempotent checkout, private status, single dispatch, callback authentication/deduplication and sandbox isolation');

    settings = await service.savePayHeroSettings({ ...settingsInput,version: settings.version,mode: 'live' },'fixture');
    await assert.rejects(service.retryPublicCheckout(first.checkout.id,first.body.checkout_token,randomUUID()),/environment changed/);
    await service.initiateAdminPayment(first.checkout.id,randomUUID(),'fixture');
    const live = await attemptFor(first.checkout.id);
    assert.equal(live.mode,'live');
    await service.processPayHeroAttempt(live.id,transport);
    const liveNotice = await notify(live); states.set(liveNotice.record.reference,'SUCCESS');
    await due(live.id); await service.processPayHeroAttempt(live.id,transport);
    assert.equal((await attemptFor(first.checkout.id)).state,'succeeded');
    const purchase = (await pool.query('SELECT * FROM billing_purchases WHERE id=$1',[first.checkout.id])).rows[0];
    assert.equal(purchase.payment_status,'paid'); assert.equal(purchase.access_status,'awaiting_activation');
    const sub = (await pool.query('SELECT * FROM billing_subscriptions WHERE purchase_id=$1',[purchase.id])).rows[0];
    assert.equal(sub.status,'pending_activation'); assert.equal(sub.activation_at,null); assert.equal(sub.expires_at,null);
    assert.equal((await pool.query('SELECT credentials_issued FROM billing_access_accounts WHERE subscription_id=$1',[sub.id])).rows[0].credentials_issued,false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_access_jobs WHERE subscription_id=$1',[sub.id])).rows[0].n,1);
    await service.receivePayHeroCallback(live.id,liveNotice.secret,liveNotice.body); await service.recheckPayment(live.id);
    assert.equal(await service.processPayHeroAttempt(live.id,transport),false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_access_jobs')).rows[0].n,1);
    await assert.rejects(pool.query("UPDATE billing_payhero_attempts SET state='queued' WHERE id=$1",[live.id]));
    const liveReceipt = (await pool.query('SELECT * FROM billing_payment_receipts WHERE purchase_id=$1',[first.checkout.id])).rows;
    assert.equal(liveReceipt.length,1); assert.equal(liveReceipt[0].method,'payhero'); assert.equal(liveReceipt[0].amount_minor,5000); assert.equal(liveReceipt[0].reference,liveNotice.record.receipt);
    console.log('PASS: verified live result records one receipt and queues one access job; no activation time, expiry or credentials; successful attempt cannot be reset or fulfilled twice');

    const unknown = await make('0712345679'); timeoutNext = true;
    const beforeTimeout = posts;
    await service.processPayHeroAttempt(unknown.attempt.id,transport);
    assert.equal((await attemptFor(unknown.checkout.id)).state,'uncertain');
    await service.initiateAdminPayment(unknown.checkout.id,randomUUID(),'fixture');
    await due(unknown.attempt.id); await service.processPayHeroAttempt(unknown.attempt.id,transport);
    assert.equal(posts,beforeTimeout+1,'Uncertain initiation must never repeat the POST');
    const recovered = await notify(unknown.attempt); states.set(recovered.record.reference,'SUCCESS');
    await due(unknown.attempt.id); await service.processPayHeroAttempt(unknown.attempt.id,transport);
    assert.equal((await attemptFor(unknown.checkout.id)).state,'succeeded');
    assert.equal(posts,beforeTimeout+1);

    const mismatch = await make('0712345680'); await service.processPayHeroAttempt(mismatch.attempt.id,transport);
    const bad = await notify(mismatch.attempt,{ Amount: 49 }); states.set(bad.record.reference,'SUCCESS');
    await due(mismatch.attempt.id); await service.processPayHeroAttempt(mismatch.attempt.id,transport);
    assert.equal((await attemptFor(mismatch.checkout.id)).state,'review');
    assert.equal((await pool.query('SELECT payment_status FROM billing_purchases WHERE id=$1',[mismatch.checkout.id])).rows[0].payment_status,'needs_review');

    const duplicate = await make('0712345681'); await service.processPayHeroAttempt(duplicate.attempt.id,transport);
    const dupRecord = requests.get(duplicate.attempt.external_reference); dupRecord.receipt = liveNotice.record.receipt;
    await notify(duplicate.attempt); states.set(dupRecord.reference,'SUCCESS');
    await due(duplicate.attempt.id); await service.processPayHeroAttempt(duplicate.attempt.id,transport);
    assert.equal((await attemptFor(duplicate.checkout.id)).state,'review');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_subscriptions')).rows[0].n,2);
    console.log('PASS: uncertain requests are not recharged, scoped receipt recovery works, amount mismatch and duplicate receipts cannot grant access');

    const beforeStale = (await pool.query('SELECT count(*)::int AS n FROM billing_customers')).rows[0].n;
    await assert.rejects(service.publicCheckout('fixture',{ ...first.body,mode: settings.mode,request_key: randomUUID(),package_version: offer.version+1 }));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_customers')).rows[0].n,beforeStale);
    const failed = await make('0712345683');
    await service.processPayHeroAttempt(failed.attempt.id,transport);
    const failedRecord = requests.get(failed.attempt.external_reference); states.set(failedRecord.reference,'FAILED');
    await due(failed.attempt.id); await service.processPayHeroAttempt(failed.attempt.id,transport);
    assert.equal((await attemptFor(failed.checkout.id)).state,'failed');
    await assert.rejects(service.retryPublicCheckout(failed.checkout.id,failed.body.checkout_token,randomUUID()),/Wait a minute/);
    console.log('PASS: definitive failure recorded; checking the real per-phone retry cooldown before a fresh attempt');
    await new Promise((resolve) => setTimeout(resolve,31000));
    await new Promise((resolve) => setTimeout(resolve,31000));
    await service.retryPublicCheckout(failed.checkout.id,failed.body.checkout_token,randomUUID());
    const retried = await attemptFor(failed.checkout.id); assert.notEqual(retried.id,failed.attempt.id);
    await service.processPayHeroAttempt(retried.id,transport);
    const retryNotice = await notify(retried); states.set(retryNotice.record.reference,'SUCCESS');
    await due(retried.id); await service.processPayHeroAttempt(retried.id,transport);
    assert.equal((await attemptFor(failed.checkout.id)).state,'succeeded');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_payhero_attempts WHERE purchase_id=$1',[failed.checkout.id])).rows[0].n,2);
    console.log('PASS: explicit retry after definitive failure preserves both attempts and verifies the replacement payment');
    const queued = await make('0712345682'), beforeDisable = posts;
    settings = await service.savePayHeroSettings({ ...settingsInput,version: settings.version,mode: 'live',enabled: false,username: '',password: '' },'fixture');
    await service.processPayHeroAttempt(queued.attempt.id,transport);
    assert.equal(posts,beforeDisable); assert.equal((await attemptFor(queued.checkout.id)).state,'failed');
    assert.deepEqual((await control.query('SELECT * FROM billing_payhero_settings')).rows,originalPointer);
    console.log('PASS: stale package terms roll back, disabling/changing settings stops queued dispatch, application settings remain untouched');
  } finally {
    if (pool) await pool.end();
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end();
    assert.equal(path.dirname(secretDir),tmpdir()); await rm(secretDir,{ recursive: true,force: true });
    console.log('Disposable PayHero test schema removed. No provider network requests, STK prompts, real payments or router operations occurred.');
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
