const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');
const { expireSimulations } = require('/app/dist/modules/billing/subscriptions');

async function main() {
  const users = [], tokens = [], suffix = randomUUID();
  let customerId, packageId;
  const api = async (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
    const r = await fetch(`http://127.0.0.1:3001/api/billing${path}`, { method,signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json',...(token ? { Authorization: `Bearer ${token}` } : {}) },...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status,data: await r.json() };
  };
  const dbError = async (sql, values) => { let code; try { await pool.query(sql,values); } catch (e) { code = e.code; } assert.equal(code,'23514'); };
  try {
    assert.equal((await api('/sessions')).status,401);
    for (const role of ['admin','viewer']) {
      const username = `sess_${role}_${suffix}`, password = randomUUID();
      const user = await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id', [username,await bcrypt.hash(password,12),role]);
      users.push(user.rows[0].id);
      const login = await fetch('http://127.0.0.1:3001/api/auth/login', { method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ username,password }) });
      assert.equal(login.status,200); tokens.push((await login.json()).token);
    }
    const [token,viewer] = tokens;
    assert.equal((await api('/sessions', { token: viewer })).status,403);
    const customer = await api('/customers', { token,body: { full_name: `Session fixture ${suffix}` } });
    assert.equal(customer.status,201); customerId = customer.data.id;
    const offer = await api('/packages', { token,body: { name: `Session offer ${suffix}`,amount_minor: 1000,currency: 'KES',duration_value: 1,duration_unit: 'hour',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,enabled: true } });
    assert.equal(offer.status,201); packageId = offer.data.id;
    const makePayment = async () => {
      const r = await api('/payments', { token,body: { customer_id: customerId,package_id: packageId,package_version: 1,payer_phone: '0712345678',request_key: randomUUID() } });
      assert.equal(r.status,201); return r.data.id;
    };
    const payment = await makePayment();
    const live = await api('/subscriptions', { token,body: { purchase_id: payment,mode: 'live' } });
    const sim = await api('/subscriptions', { token,body: { purchase_id: payment,mode: 'simulation',confirm_simulation: true } });
    const records = (await api('/subscriptions', { token })).data;
    const account = records.find((s) => s.id === sim.data.id), liveAccount = records.find((s) => s.id === live.data.id);
    const start = { action: 'start',account_id: account.account_id,client_ip: '192.0.2.10',client_mac: '02:00:00:00:00:01',router_label: `Test ${suffix}`,request_key: randomUUID(),confirm_simulation: true };
    assert.equal((await api('/sessions/simulation', { token,body: start })).status,409);
    assert.equal((await api('/sessions/simulation', { token,body: { ...start,account_id: liveAccount.account_id } })).status,409);
    assert.equal((await api('/sessions/simulation', { token,body: { ...start,confirm_simulation: false } })).status,400);
    await api(`/subscriptions/${sim.data.id}/activate-simulation`, { token,body: { confirm_simulation: true } });
    const starts = await Promise.all(Array.from({ length: 5 }, () => api('/sessions/simulation', { token,body: start })));
    assert.equal(starts.filter((r) => r.status === 201).length,1);
    assert.ok(starts.every((r) => [200,201].includes(r.status))); assert.equal(new Set(starts.map((r) => r.data.session_id)).size,1);
    const id = starts[0].data.session_id;
    assert.equal((await api('/sessions/simulation', { token,body: { ...start,router_label: 'Changed test' } })).status,409);
    const overlap = await Promise.all(Array.from({ length: 3 }, () => api('/sessions/simulation', { token,body: { ...start,request_key: randomUUID() } })));
    assert.ok(overlap.every((r) => r.status === 409));
    assert.equal((await api(`/sessions/${id}`, { token: viewer })).status,403);
    console.log('PASS: session permissions, explicit test consent, live/pending guards, concurrent replay and one-active-session limit');

    const usage = { action: 'update',download_bytes: 2500000,upload_bytes: 750000,request_key: randomUUID(),confirm_simulation: true };
    const updates = await Promise.all(Array.from({ length: 4 }, () => api(`/sessions/${id}/simulation`, { token,body: usage })));
    assert.ok(updates.every((r) => r.status === 200));
    assert.equal((await api(`/sessions/${id}/simulation`, { token,body: { ...usage,download_bytes: 1,request_key: randomUUID() } })).status,409);
    let detail = await api(`/sessions/${id}`, { token });
    assert.equal(detail.data.events.length,2); assert.equal(detail.data.session.download_bytes,2500000);
    assert.equal(detail.data.session.upload_bytes,750000); assert.equal(detail.data.session.customer_id,customerId);
    assert.equal(detail.data.session.source,'simulation'); assert.equal(detail.data.session.client_mac,'02:00:00:00:00:01');
    const originalStart = detail.data.session.started_at;
    const stop = { ...usage,action: 'stop',download_bytes: 3000000,request_key: randomUUID() };
    assert.equal((await api(`/sessions/${id}/simulation`, { token,body: stop })).status,200);
    const closed = (await api(`/sessions/${id}`, { token })).data;
    assert.equal(closed.session.started_at,originalStart); assert.ok(closed.session.ended_at); assert.equal(closed.session.end_reason,'test_stopped');
    assert.equal(closed.events.length,3);
    assert.equal((await api(`/sessions/${id}/simulation`, { token,body: stop })).status,200);
    assert.equal((await api(`/sessions/${id}/simulation`, { token,body: { ...usage,request_key: randomUUID() } })).status,409);
    await dbError('UPDATE billing_sessions SET download_bytes=download_bytes+1 WHERE id=$1',[id]);
    const reconnect = await api('/sessions/simulation', { token,body: { ...start,request_key: randomUUID() } });
    assert.equal(reconnect.status,201); assert.notEqual(reconnect.data.session_id,id);
    const payState = (await pool.query('SELECT payment_status,access_status FROM billing_purchases WHERE id=$1',[payment])).rows[0];
    assert.equal(payState.payment_status,'pending'); assert.equal(payState.access_status,'not_activated');
    assert.equal((await pool.query('SELECT credentials_issued,router_id FROM billing_access_accounts WHERE id=$1',[account.account_id])).rows[0].credentials_issued,false);
    console.log('PASS: cumulative counters, duplicate usage protection, closed-session immutability, reconnect history and unchanged payment/credentials');

    // Past timestamps are isolated fixtures; the public API accepts no timestamps.
    const pastPayment = await makePayment(), pastSub = randomUUID(), pastAccount = randomUUID(), pastSession = randomUUID();
    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(`INSERT INTO billing_subscriptions(id,purchase_id,mode,status,activation_at,expires_at) VALUES($1,$2,'simulation','active',now()-interval '2 hours',now()-interval '1 hour')`,[pastSub,pastPayment]);
      await fixture.query("INSERT INTO billing_access_accounts(id,subscription_id,username,state) VALUES($1,$2,$3,'simulated_ready')",[pastAccount,pastSub,`sim_fixture_${suffix}`]);
      await fixture.query(`INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at) VALUES($1,$2,'simulation','192.0.2.20','02:00:00:00:00:02','Expiry fixture',now()-interval '90 minutes',now()-interval '90 minutes')`,[pastSession,pastAccount]);
      await fixture.query('COMMIT');
    } catch (e) { await fixture.query('ROLLBACK'); throw e; }
    finally { fixture.release(); }
    await expireSimulations(); await expireSimulations();
    const expired = (await api(`/sessions/${pastSession}`, { token })).data;
    assert.equal(expired.session.end_reason,'subscription_expired'); assert.equal(expired.session.ended_at,expired.session.subscription_expires_at);
    assert.equal(expired.session.duration_seconds,1800); assert.equal(expired.events.length,1); assert.equal(expired.events[0].reason,'subscription_expired');
    assert.equal((await api('/sessions/simulation', { token,body: { ...start,account_id: pastAccount,request_key: randomUUID() } })).status,409);
    await dbError(`INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at) VALUES($1,$2,'simulation','192.0.2.1','02:00:00:00:00:03','Blocked live',now(),now())`,[randomUUID(),liveAccount.account_id]);
    console.log('PASS: subscription expiry closes test accounting exactly once at the entitlement boundary; live accounts also blocked by database');

    await pool.query(`INSERT INTO billing_sessions(id,account_id,source,client_ip,client_mac,router_label,started_at,updated_at,ended_at,end_reason,download_bytes)
      SELECT gen_random_uuid(),$1,'simulation','192.0.2.30','02:00:00:00:00:04',$2,now()-interval '1 minute',now(),now(),'test_stopped',1000 FROM generate_series(1,52)`,[account.account_id,`page_${suffix}`]);
    const page1 = (await api(`/sessions?q=${encodeURIComponent(`page_${suffix}`)}`, { token })).data;
    const page2 = (await api(`/sessions?q=${encodeURIComponent(`page_${suffix}`)}&offset=50`, { token })).data;
    assert.equal(page1.items.length,50); assert.equal(page2.items.length,2); assert.equal(page1.summary.total,52); assert.equal(page1.summary.download_bytes,52000);
    assert.equal(new Set([...page1.items,...page2.items].map((s) => s.id)).size,52);
    assert.equal((await api(`/sessions?q=${encodeURIComponent(`page_${suffix}`)}&status=active`, { token })).data.summary.total,0);
    console.log('PASS: stable pagination, search, status filters and summaries across the full result set');
  } finally {
    for (const token of tokens) await fetch('http://127.0.0.1:3001/api/auth/logout', { method: 'POST',headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    if (customerId) {
    if ([customerId].length) {
      for (const table of ['billing_access_alerts','billing_access_jobs','billing_management_events','billing_renewals','billing_customer_controls','billing_access_policy','billing_customer_devices']) await pool.query('DELETE FROM '+table+' WHERE customer_id=ANY($1::int[])',[[customerId]]);
      await pool.query(`DELETE FROM billing_subscription_runtime WHERE subscription_id IN (SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=ANY($1::int[]))`,[[customerId]]);
    }
      const subs = (await pool.query('SELECT s.id FROM billing_subscriptions s JOIN billing_purchases p ON p.id=s.purchase_id WHERE p.customer_id=$1',[customerId])).rows.map((r) => r.id);
      const accounts = (await pool.query('SELECT id FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])',[subs])).rows.map((r) => r.id);
      await pool.query('DELETE FROM billing_session_events WHERE session_id IN (SELECT id FROM billing_sessions WHERE account_id=ANY($1::uuid[]))',[accounts]);
      await pool.query('DELETE FROM billing_sessions WHERE account_id=ANY($1::uuid[])',[accounts]);
      await pool.query('DELETE FROM billing_access_events WHERE subscription_id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_subscriptions WHERE id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_purchases WHERE customer_id=$1',[customerId]);
      await pool.query('DELETE FROM billing_customers WHERE id=$1',[customerId]);
    }
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1',[packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);
    await pool.end(); console.log('Session fixtures removed. No router, credentials or real payment was used.');
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
