const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');
const { expireSimulations } = require('/app/dist/modules/billing/subscriptions');
const { reconcileAccessManagement, reconcileRenewals, generateAccessAlerts } = require('/app/dist/modules/billing/accessReconciliation');

async function main() {
  const customers = [], users = [], keys = [], tokens = [];
  const suffix = randomUUID().slice(0,10);
  let token, packageId;
  const api = async (path,body,method = body ? 'POST' : 'GET',auth = token) => {
    const r = await fetch(`http://127.0.0.1:3001/api/billing${path}`,{ method,signal: AbortSignal.timeout(20000),headers: { 'Content-Type': 'application/json',...(auth ? { Authorization: `Bearer ${auth}` } : {}) },...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status,data: await r.json() };
  };
  const ok = (r,status = 200) => { assert.equal(r.status,status,JSON.stringify(r.data)); return r.data; };
  const operation = (fields) => { const key = randomUUID(); keys.push(key); return { request_key: key,reason: 'Access integration fixture',...fields }; };
  try {
    const password = randomUUID(), username = `management_${suffix}`;
    users.push((await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,await bcrypt.hash(password,12),'admin'])).rows[0].id);
    const login = await fetch('http://127.0.0.1:3001/api/auth/login',{ method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ username,password }) });
    assert.equal(login.status,200); token = (await login.json()).token; tokens.push(token);
    const macs = [1,2,3].map((n) => `02:${suffix.slice(0,2)}:${suffix.slice(2,4)}:10:00:0${n}`);
    const c = ok(await api('/customers',{ full_name: `Access fixture ${suffix}`,first_device_mac: macs[0],first_device_label: 'Phone' }),201); customers.push(c.id);
    const other = ok(await api('/customers',{ full_name: `Other access fixture ${suffix}` }),201); customers.push(other.id);
    assert.equal((await api('/customers',{ full_name: `Duplicate MAC ${suffix}`,first_device_mac: macs[0] })).status,409);
    assert.equal((await pool.query('SELECT id FROM billing_customers WHERE full_name=$1',[`Duplicate MAC ${suffix}`])).rowCount,0);
    const path = `/access-management/customers/${c.id}`;
    assert.equal((await api(path,undefined,'GET',null)).status,401);
    let view = ok(await api(path)); assert.equal(view.devices.length,1);
    for (let i = 1; i<3; i++) ok(await api(`${path}/devices`,operation({ mac: macs[i],label: `Device ${i+1}` })));
    view = ok(await api(path));
    const openSchedule = { enabled: false,timezone: 'UTC',windows: [] };
    const policy = (version,schedule = openSchedule,extra = {}) => operation({ version,max_devices: 3,max_sessions: 2,registered_only: true,schedule,...extra });
    ok(await api(`${path}/policy`,policy(0),'PUT'));
    assert.equal((await api(`${path}/policy`,policy(0),'PUT')).status,409);
    const offer = ok(await api('/packages',{ name: `Access offer ${suffix}`,amount_minor: 1000,currency: 'KES',duration_value: 1,duration_unit: 'hour',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,enabled: true }),201); packageId = offer.id;
    const grant = async (mode = 'simulation',cid = c.id) => ok(await api(`/customers/${cid}/complimentary-access`,{ package_id: packageId,package_version: 1,mode,reason: 'Access fixture grant',request_key: randomUUID(),confirm_complimentary: true,confirm_simulation: true }),201);
    const a = await grant(), b = await grant(), revoked = await grant(), live = await grant('live');
    const activate = (id) => api(`/subscriptions/${id}/activate-simulation`,{ confirm_simulation: true });
    const original = ok(await activate(a.subscription_id));
    const periods = () => api(`/subscriptions?customer_id=${c.id}`).then((r) => ok(r));
    const account = (await periods()).find((s) => s.id === a.subscription_id);
    const start = (mac) => api('/sessions/simulation',{ action: 'start',account_id: account.account_id,client_ip: '192.0.2.90',client_mac: mac,router_label: 'Access management test',request_key: randomUUID(),confirm_simulation: true });
    const starts = await Promise.all(macs.map(start));
    assert.equal(starts.filter((r) => r.status === 201).length,2); assert.equal(starts.filter((r) => r.status === 409).length,1);
    assert.equal((await start('02:ff:ff:10:00:99')).status,409);
    const sessions = ok(await api(`/sessions?customer_id=${c.id}&status=active`)).items;
    assert.equal(sessions.length,2);
    const first = sessions[0];
    ok(await api(`/sessions/${first.id}/simulation`,{ action: 'update',download_bytes: 123456,upload_bytes: 9876,request_key: randomUUID(),confirm_simulation: true }));
    const device = view.devices.find((d) => d.mac === first.client_mac);
    const disable = operation({ version: device.version,label: device.label,enabled: false });
    ok(await api(`${path}/devices/${device.id}`,disable,'PUT')); ok(await api(`${path}/devices/${device.id}`,disable,'PUT'));
    const closed = ok(await api(`/sessions/${first.id}`)).session;
    assert.equal(closed.end_reason,'device_disabled'); assert.equal(closed.download_bytes,123456); assert.equal(closed.upload_bytes,9876);
    ok(await api(`${path}/disconnect`,operation({})));
    assert.equal(ok(await api(`/sessions?customer_id=${c.id}&status=active`)).summary.active,0);
    console.log('PASS: optional initial MAC transaction, duplicate rollback, device policy, customer-wide concurrent connection limit, disable/disconnect and preserved counters');

    const pause = operation({ version: 0,state: 'vacation' });
    ok(await api(`${path}/control`,pause)); ok(await api(`${path}/control`,pause));
    assert.equal((await api(`${path}/control`,{ ...pause,state: 'enabled' })).status,409);
    let paused = (await periods()).find((s) => s.id === a.subscription_id);
    assert.equal(paused.access_state,'paused'); assert.ok(paused.frozen_remaining_ms>3500000); assert.equal(paused.expires_at,null);
    assert.equal(paused.activation_at,original.activation_at); assert.equal(paused.original_expires_at,original.expires_at);
    assert.equal((await pool.query("SELECT id FROM billing_management_events WHERE customer_id=$1 AND kind='pause_confirmed_simulation'",[c.id])).rowCount,1);
    await pool.query("UPDATE billing_subscription_runtime SET effective_expires_at=clock_timestamp()-interval '1 minute' WHERE subscription_id=$1",[a.subscription_id]);
    await expireSimulations(); assert.equal((await periods()).find((s) => s.id === a.subscription_id).status,'active');
    const closedSchedule = { enabled: true,timezone: 'UTC',windows: [{ days: [(new Date().getUTCDay()+2)%7],start: '00:00',end: '00:01' }] };
    ok(await api(`${path}/policy`,policy(1,closedSchedule),'PUT'));
    ok(await api(`${path}/control`,operation({ version: 1,state: 'enabled' })));
    await reconcileAccessManagement();
    paused = (await periods()).find((s) => s.id === a.subscription_id); assert.equal(paused.access_state,'paused'); assert.equal((await start(macs[1])).status,409);
    ok(await api(`${path}/policy`,policy(2),'PUT')); await reconcileAccessManagement();
    const resumed = (await periods()).find((s) => s.id === a.subscription_id);
    assert.equal(resumed.frozen_remaining_ms,null); assert.equal(resumed.original_expires_at,original.expires_at); assert.equal(resumed.activation_at,original.activation_at);
    assert.ok(new Date(resumed.expires_at).getTime()-Date.now()>3500000);
    ok(await api(`${path}/control`,operation({ version: 2,state: 'suspended' })));
    assert.equal((await start(macs[1])).status,409);
    assert.equal((await periods()).find((s) => s.id === a.subscription_id).expires_at,resumed.expires_at);
    ok(await api(`${path}/control`,operation({ version: 3,state: 'enabled' })));
    const liveRuntime = (await pool.query('SELECT * FROM billing_subscription_runtime WHERE subscription_id=$1',[live.subscription_id])).rows[0];
    assert.equal(liveRuntime.frozen_remaining_ms,null); assert.equal(liveRuntime.applied_state,'unknown');
    assert.equal((await activate(live.subscription_id)).status,409);
    console.log('PASS: idempotent confirmed vacation, no paused expiry, resume waits for scheduled readiness, suspension clock continues, preserved original timestamps and live enforcement remains pending');

    ok(await api(`${path}/revoke/${revoked.subscription_id}`,operation({})));
    assert.equal((await activate(revoked.subscription_id)).status,409);
    assert.equal((await api(`/access-management/customers/${other.id}/revoke/${a.subscription_id}`,operation({}))).status,404);
    const queued = operation({ predecessor_id: a.subscription_id,successor_id: b.subscription_id });
    ok(await api(`${path}/renewal`,queued)); ok(await api(`${path}/renewal`,queued));
    await reconcileRenewals(); assert.equal((await periods()).find((s) => s.id === b.subscription_id).activation_at,null);
    assert.equal((await activate(b.subscription_id)).status,409);
    await pool.query("UPDATE billing_subscription_runtime SET effective_expires_at=clock_timestamp()-interval '1 second' WHERE subscription_id=$1",[a.subscription_id]);
    await expireSimulations(); await reconcileRenewals(); await reconcileRenewals();
    const after = await periods(), replacement = after.find((s) => s.id === b.subscription_id);
    assert.equal(replacement.status,'active'); assert.equal(new Date(replacement.expires_at)-new Date(replacement.activation_at),3600000);
    assert.equal(after.find((s) => s.id === a.subscription_id).original_expires_at,original.expires_at);
    await generateAccessAlerts(); await generateAccessAlerts();
    const alerts = ok(await api('/access-management/alerts')).filter((r) => r.customer_id === c.id);
    assert.equal(alerts.filter((r) => r.subscription_id === b.subscription_id && r.kind === 'expiry_soon').length,1);
    assert.equal(alerts.filter((r) => r.subscription_id === a.subscription_id).length,0);
    const alert = alerts.find((r) => r.subscription_id === b.subscription_id);
    const read = ok(await api(`/access-management/alerts/${alert.id}/read`,{}));
    assert.equal(ok(await api(`/access-management/alerts/${alert.id}/read`,{})).read_at,read.read_at);
    const job = (await pool.query("UPDATE billing_access_jobs SET status='failed',last_error='Fixture failure' WHERE kind='prepare' AND scope_key=$1 RETURNING id",[live.subscription_id])).rows[0];
    await generateAccessAlerts(); await generateAccessAlerts();
    assert.equal(ok(await api(path)).alerts.filter((r) => r.kind === 'provisioning_failed').length,1);
    await pool.query("UPDATE billing_access_jobs SET status='superseded' WHERE id=$1",[job.id]); await generateAccessAlerts();
    assert.equal(ok(await api(path)).alerts.filter((r) => r.kind === 'provisioning_failed').length,0);
    assert.equal((await api(`${path}/control`,operation({ version: 4,state: 'enabled',status: 'applied_simulation' }))).status,400);
    // Hold the customer lock while expiry starts, then confirm a pause. Expiry
    // must wait and re-read the runtime after the confirmation commits.
    const racePeriod = await grant(); ok(await activate(racePeriod.subscription_id));
    await pool.query("INSERT INTO billing_subscription_runtime(subscription_id,effective_expires_at) VALUES($1,clock_timestamp()-interval '1 second') ON CONFLICT(subscription_id) DO UPDATE SET effective_expires_at=EXCLUDED.effective_expires_at",[racePeriod.subscription_id]);
    const blocker = await pool.connect();
    let expiryRun,expiryFinished = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM billing_customers WHERE id=$1 FOR UPDATE',[c.id]);
      expiryRun = expireSimulations().finally(() => { expiryFinished = true; });
      let waiting = false;
      for (let n = 0; n<100 && !waiting && !expiryFinished; n++) {
        waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM billing_customers WHERE id=%FOR UPDATE') AS waiting")).rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve,20));
      }
      assert.ok(waiting && !expiryFinished,'Expiry must serialize behind the customer operation');
      await blocker.query("UPDATE billing_subscription_runtime SET frozen_remaining_ms=3600000,pause_confirmed_at=clock_timestamp(),applied_state='vacation' WHERE subscription_id=$1",[racePeriod.subscription_id]);
      await blocker.query('COMMIT');
    } catch (e) { await blocker.query('ROLLBACK'); throw e; } finally { blocker.release(); }
    await expiryRun;
    assert.equal((await pool.query('SELECT status FROM billing_subscriptions WHERE id=$1',[racePeriod.subscription_id])).rows[0].status,'active');
    console.log('PASS: expiry waits for a simultaneous pause and re-reads confirmed state');
    const race = await Promise.all(['enabled','suspended'].map((state) => api(`${path}/control`,operation({ version: 4,state }))));
    assert.equal(race.filter((r) => r.status === 200).length,1); assert.equal(race.filter((r) => r.status === 409).length,1);
    assert.equal((await pool.query('SELECT activation_at,expires_at FROM billing_subscriptions WHERE id=$1',[live.subscription_id])).rows[0].activation_at,null);
    console.log('PASS: permanent complimentary revocation, customer isolation, no early renewal or forfeiture, replacement duration, deduplicated/read/resolved alerts, forged-status rejection and control concurrency');
  } finally {
    for (const auth of tokens) await fetch('http://127.0.0.1:3001/api/auth/logout',{ method: 'POST',headers: { Authorization: `Bearer ${auth}` } }).catch(() => {});
    if (customers.length) {
      // Stop background reconciliation from seeing fixtures during dependency cleanup.
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT id FROM billing_customers WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[customers]);
        const subs = (await client.query(`SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=ANY($1::int[])`,[customers])).rows.map((r) => r.id);
        for (const table of ['billing_access_alerts','billing_access_jobs','billing_management_events','billing_renewals','billing_customer_controls','billing_access_policy','billing_customer_devices']) await client.query('DELETE FROM '+table+' WHERE customer_id=ANY($1::int[])',[customers]);
        await client.query('DELETE FROM billing_management_requests WHERE request_key=ANY($1::uuid[])',[keys]);
        await client.query('DELETE FROM billing_subscription_runtime WHERE subscription_id=ANY($1::uuid[])',[subs]);
        await client.query('DELETE FROM billing_session_events WHERE session_id IN (SELECT x.id FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id WHERE a.subscription_id=ANY($1::uuid[]))',[subs]);
        await client.query('DELETE FROM billing_sessions WHERE account_id IN (SELECT id FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[]))',[subs]);
        await client.query('DELETE FROM billing_access_events WHERE subscription_id=ANY($1::uuid[])',[subs]);
        await client.query('DELETE FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])',[subs]);
        await client.query('DELETE FROM billing_subscriptions WHERE id=ANY($1::uuid[])',[subs]);
        await client.query('DELETE FROM billing_access_grants WHERE customer_id=ANY($1::int[])',[customers]);
        await client.query('DELETE FROM billing_customers WHERE id=ANY($1::int[])',[customers]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1',[packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);
    await pool.end(); console.log('Access management fixtures removed. No live router operation or payment collection was performed.');
  }
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
