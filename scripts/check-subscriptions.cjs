const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');
const { expireSimulations, SIMULATION_TIMES } = require('/app/dist/modules/billing/subscriptions');

async function main() {
  const keys = [], users = [], sessions = [];
  let customerId, packageId;
  const suffix = randomUUID().slice(0,12);
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:3001/api${path}`, { method, signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  const dbError = async (sql, values, expected) => {
    let code; try { await pool.query(sql, values); } catch (e) { code = e.code; }
    assert.equal(code, expected);
  };
  try {
    assert.equal((await api('/billing/subscriptions')).status, 401);
    for (const role of ['admin','viewer']) {
      const username = `subcheck_${role}_${suffix}`, password = randomUUID();
      const u = await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id', [username, await bcrypt.hash(password, 12),role]);
      users.push(u.rows[0].id);
      const login = await api('/auth/login', { method: 'POST', body: { username,password } });
      assert.equal(login.status, 200); sessions.push({ role,token: login.data.token });
    }
    const token = sessions.find((s) => s.role === 'admin').token;
    const viewer = sessions.find((s) => s.role === 'viewer').token;
    assert.equal((await api('/billing/subscriptions', { token: viewer })).status, 403);
    const customer = await api('/billing/customers', { method: 'POST',token,body: { full_name: `Subscription fixture ${suffix}` } });
    assert.equal(customer.status, 201); customerId = customer.data.id;
    const offer = await api('/billing/packages', { method: 'POST',token,body: { name: `Subscription offer ${suffix}`, amount_minor: 1000,currency: 'KES',
      duration_value: 1,duration_unit: 'hour',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,enabled: true } });
    assert.equal(offer.status, 201); packageId = offer.data.id;
    const makePayment = async () => {
      const key = randomUUID(); keys.push(key);
      const p = await api('/billing/payments', { method: 'POST',token,body: { customer_id: customerId,package_id: packageId,package_version: 1,payer_phone: '0712345678',request_key: key } });
      assert.equal(p.status, 201); return p.data;
    };
    const payment = await makePayment();
    const prepares = await Promise.all(Array.from({ length: 5 }, () => api('/billing/subscriptions', { method: 'POST',token,body: { purchase_id: payment.id,mode: 'live' } })));
    assert.equal(prepares.filter((r) => r.status === 201).length, 1);
    assert.ok(prepares.every((r) => [200,201].includes(r.status)));
    assert.equal(new Set(prepares.map((r) => r.data.id)).size, 1);
    const live = prepares[0].data;
    assert.equal(live.status, 'awaiting_payment'); assert.equal(live.activation_at, null);
    assert.equal((await api(`/billing/subscriptions/${live.id}/activate-simulation`, { method: 'POST',token,body: { confirm_simulation: true } })).status, 409);
    assert.equal((await api('/billing/subscriptions', { method: 'POST',token,body: { purchase_id: payment.id,mode: 'simulation' } })).status, 400);
    const simulation = await api('/billing/subscriptions', { method: 'POST',token,body: { purchase_id: payment.id,mode: 'simulation',confirm_simulation: true } });
    assert.equal(simulation.status, 201); assert.equal(simulation.data.activation_at, null);
    console.log('PASS: permissions, idempotent preparation, unstarted live period and explicit simulation consent');
    const activations = await Promise.all(Array.from({ length: 5 }, () => api(`/billing/subscriptions/${simulation.data.id}/activate-simulation`, { method: 'POST',token,body: { confirm_simulation: true } })));
    assert.ok(activations.every((r) => r.status === 200));
    assert.equal(new Set(activations.map((r) => r.data.activation_at)).size, 1);
    const active = activations[0].data;
    assert.equal(new Date(active.expires_at) - new Date(active.activation_at), 3600000);
    const activationEvents = await pool.query("SELECT count(*)::int AS n FROM billing_access_events WHERE subscription_id=$1 AND kind='simulation_activated'", [active.id]);
    assert.equal(activationEvents.rows[0].n, 1);
    const purchase = (await pool.query('SELECT payment_status,access_status FROM billing_purchases WHERE id=$1', [payment.id])).rows[0];
    assert.equal(purchase.payment_status, 'pending'); assert.equal(purchase.access_status, 'not_activated');
    await dbError("UPDATE billing_subscriptions SET activation_at=activation_at+interval '1 minute' WHERE id=$1", [active.id], '23514');
    await dbError("UPDATE billing_subscriptions SET status='active',activation_at=now(),expires_at=now()+interval '1 hour' WHERE id=$1", [live.id], '23514');
    await dbError('UPDATE billing_access_accounts SET credentials_issued=true WHERE subscription_id=$1', [live.id], '23514');
    console.log('PASS: concurrent activation preserves one effective period/event; payment stays pending; real activation/credentials blocked');
    await expireSimulations();
    assert.equal((await pool.query('SELECT status FROM billing_subscriptions WHERE id=$1', [active.id])).rows[0].status, 'active');
    const pastPayment = await makePayment(), pastId = randomUUID();
    const fixtureClient = await pool.connect();
    try {
      await fixtureClient.query('BEGIN');
      await fixtureClient.query(`INSERT INTO billing_subscriptions(id,purchase_id,mode,status,activation_at,expires_at)
        VALUES($1,$2,'simulation','active',now()-interval '2 hours',now()-interval '1 hour')`, [pastId,pastPayment.id]);
      await fixtureClient.query(`INSERT INTO billing_access_accounts(id,subscription_id,username,state)
        VALUES($1,$2,$3,'simulated_ready')`, [randomUUID(),pastId,`sim_fixture_${randomUUID()}`]);
      await fixtureClient.query('COMMIT');
    } catch (error) { await fixtureClient.query('ROLLBACK'); throw error; }
    finally { fixtureClient.release(); }
    await expireSimulations(); await expireSimulations();
    const expired = (await pool.query(`SELECT s.status,a.state FROM billing_subscriptions s JOIN billing_access_accounts a ON a.subscription_id=s.id WHERE s.id=$1`, [pastId])).rows[0];
    assert.equal(expired.status, 'expired'); assert.equal(expired.state, 'simulated_expired');
    const retry = await api(`/billing/subscriptions/${pastId}/activate-simulation`, { method: 'POST',token,body: { confirm_simulation: true } });
    assert.equal(retry.data.status, 'expired');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_access_events WHERE subscription_id=$1 AND kind='simulation_expired'", [pastId])).rows[0].n, 1);
    const fixedTimes = SIMULATION_TIMES.replace('clock_timestamp()', '$4::timestamptz');
    for (const [unit,tz,start,end] of [
      ['calendar_month','Africa/Nairobi','2026-01-31T09:00:00Z','2026-02-28T09:00:00.000Z'],
      ['calendar_month','Africa/Nairobi','2028-01-31T09:00:00Z','2028-02-29T09:00:00.000Z'],
      ['day','America/New_York','2026-03-07T12:00:00Z','2026-03-08T12:00:00.000Z'],
    ]) {
      const times = (await pool.query(fixedTimes, [unit,1,tz,start])).rows[0];
      assert.equal(times.expires_at.toISOString(), end);
    }
    const list = await api('/billing/subscriptions', { token });
    const account = list.data.find((s) => s.id === active.id);
    assert.equal(account.account_state, 'simulated_ready'); assert.equal(account.credentials_issued, false);
    assert.equal(account.router_id, null); assert.equal(account.customer_id, customerId);
    console.log('PASS: due-only expiry, expired retry safety, local calendar-month clamping, DST elapsed day and linked account metadata');
  } finally {
    for (const s of sessions) await api('/auth/logout', { method: 'POST',token: s.token }).catch(() => {});
    if (customerId) {
      for (const table of ['billing_access_alerts','billing_access_jobs','billing_management_events','billing_renewals','billing_customer_controls','billing_access_policy','billing_customer_devices']) await pool.query('DELETE FROM '+table+' WHERE customer_id=ANY($1::int[])',[[customerId]]);
      await pool.query(`DELETE FROM billing_subscription_runtime WHERE subscription_id IN (SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=ANY($1::int[]))`,[[customerId]]);
    }
    if (keys.length) {
      const ids = (await pool.query(`SELECT s.id FROM billing_subscriptions s JOIN billing_purchases p ON p.id=s.purchase_id WHERE p.request_key=ANY($1::uuid[])`, [keys])).rows.map((r) => r.id);
      if (ids.length) {
        await pool.query('DELETE FROM billing_access_events WHERE subscription_id=ANY($1::uuid[])', [ids]);
        await pool.query('DELETE FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])', [ids]);
        await pool.query('DELETE FROM billing_subscriptions WHERE id=ANY($1::uuid[])', [ids]);
      }
      await pool.query('DELETE FROM billing_purchases WHERE request_key=ANY($1::uuid[])', [keys]);
    }
    if (customerId) await pool.query('DELETE FROM billing_customers WHERE id=$1', [customerId]);
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1', [packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
    await pool.end(); console.log('Subscription fixtures removed. No real payments, credentials or router commands used.');
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
