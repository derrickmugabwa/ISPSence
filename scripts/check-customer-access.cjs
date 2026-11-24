const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');

async function main() {
  const users = [], tokens = [], customers = [], suffix = randomUUID().slice(0,12);
  let packageId;
  const api = async (path, { token,body,method = body ? 'POST' : 'GET' } = {}) => {
    const r = await fetch(`http://127.0.0.1:3001/api/billing${path}`, { method,signal: AbortSignal.timeout(20000),headers: { 'Content-Type': 'application/json',...(token ? { Authorization: `Bearer ${token}` } : {}) },...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status,data: await r.json() };
  };
  const dbError = async (sql, params) => { let code; try { await pool.query(sql,params); } catch (e) { code = e.code; } assert.equal(code,'23514'); };
  try {
    for (const role of ['admin','viewer']) {
      const username = `profile_${role}_${suffix}`, password = randomUUID();
      users.push((await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,await bcrypt.hash(password,12),role])).rows[0].id);
      const login = await fetch('http://127.0.0.1:3001/api/auth/login', { method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ username,password }) });
      assert.equal(login.status,200); tokens.push((await login.json()).token);
    }
    const [token,viewer] = tokens;
    for (const name of ['Customer','Other customer']) {
      const c = await api('/customers',{ token,body: { full_name: `${name} ${suffix}`,phone: '0712345678',notes: 'Profile fixture' } });
      assert.equal(c.status,201); customers.push(c.data.id);
    }
    const [id,otherId] = customers;
    assert.equal((await api(`/customers/${id}`)).status,401);
    assert.equal((await api(`/customers/${id}`,{ token: viewer })).status,403);
    const initial = (await api(`/customers/${id}`,{ token })).data;
    assert.equal(initial.network.version,0); assert.equal(initial.network.download_bps,null); assert.equal(initial.enforcement,'not_applied');
    const offer = await api('/packages',{ token,body: { name: `Profile offer ${suffix}`,amount_minor: 1000,currency: 'KES',duration_value: 1,duration_unit: 'hour',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,enabled: true } });
    assert.equal(offer.status,201); packageId = offer.data.id;
    const purchase = await api('/payments',{ token,body: { customer_id: id,package_id: packageId,package_version: 1,payer_phone: '0712345678',request_key: randomUUID() } });
    assert.equal(purchase.status,201);
    const paidPeriod = await api('/subscriptions',{ token,body: { purchase_id: purchase.data.id,mode: 'live' } });
    assert.equal(paidPeriod.status,201);
    const grant = { package_id: packageId,package_version: 1,mode: 'live',reason: 'Staff access',request_key: randomUUID(),confirm_complimentary: true };
    assert.equal((await api(`/customers/${id}/complimentary-access`,{ token: viewer,body: grant })).status,403);
    assert.equal((await api(`/customers/${id}/complimentary-access`,{ token,body: { ...grant,confirm_complimentary: false } })).status,400);
    const free = await api(`/customers/${id}/complimentary-access`,{ token,body: grant });
    assert.equal(free.status,201);
    assert.equal((await api(`/customers/${id}/complimentary-access`,{ token,body: grant })).status,200);
    const simulation = { ...grant,mode: 'simulation',confirm_simulation: true,request_key: randomUUID() };
    const repeats = await Promise.all(Array.from({ length: 5 },() => api(`/customers/${id}/complimentary-access`,{ token,body: simulation })));
    assert.equal(repeats.filter((r) => r.status === 201).length,1); assert.ok(repeats.every((r) => [200,201].includes(r.status)));
    assert.equal(new Set(repeats.map((r) => r.data.subscription_id)).size,1);
    const simulatedId = repeats[0].data.subscription_id;
    assert.equal((await api(`/customers/${id}/complimentary-access`,{ token,body: { ...simulation,reason: 'Different reason' } })).status,409);
    assert.equal((await api(`/customers/${otherId}/complimentary-access`,{ token,body: simulation })).status,409);
    const grantRow = (await pool.query('SELECT * FROM billing_access_grants WHERE id=$1',[free.data.id])).rows[0];
    assert.equal(grantRow.charge_amount_minor,0); assert.equal(grantRow.package_snapshot.amount_minor,1000);
    assert.equal((await api(`/payments?customer_id=${id}`,{ token })).data.length,1);
    await dbError("UPDATE billing_access_grants SET reason='Changed' WHERE id=$1",[free.data.id]);
    await dbError("INSERT INTO billing_subscriptions(id,mode,status) VALUES($1,'live','pending_activation')",[randomUUID()]);
    await dbError('UPDATE billing_subscriptions SET grant_id=NULL WHERE id=$1',[free.data.subscription_id]);
    assert.equal((await api(`/subscriptions/${free.data.subscription_id}/activate-simulation`,{ token,body: { confirm_simulation: true } })).status,409);
    console.log('PASS: profile permissions, zero-charge grants separate from payments, concurrent idempotency, immutable funding and blocked live activation');

    const settings = { version: 0,download_bps: 20000000,upload_bps: 5000000,reason: 'Support adjustment' };
    assert.equal((await api(`/customers/${id}/speed-override`,{ token: viewer,method: 'PUT',body: settings })).status,403);
    const save = await api(`/customers/${id}/speed-override`,{ token,method: 'PUT',body: settings });
    assert.equal(save.status,200); assert.equal(save.data.version,1);
    const retry = await api(`/customers/${id}/speed-override`,{ token,method: 'PUT',body: settings });
    assert.equal(retry.status,200); assert.equal(retry.data.version,1); assert.equal(typeof retry.data.download_bps,'number');
    const list = (await api(`/subscriptions?customer_id=${id}`,{ token })).data;
    assert.equal(list.length,3); assert.ok(list.every((s) => s.customer_id === id && s.desired_download_bps === 20000000 && s.desired_upload_bps === 5000000 && s.speed_override && s.speed_enforcement === 'not_applied'));
    assert.ok(list.every((s) => s.package_snapshot.download_bps === 5000000 && s.package_snapshot.duration_value === 1));
    const competing = await Promise.all([25000000,30000000].map((download_bps) => api(`/customers/${id}/speed-override`,{ token,method: 'PUT',body: { ...settings,version: 1,download_bps,reason: `Concurrent ${download_bps}` } })));
    assert.equal(competing.filter((r) => r.status === 200).length,1); assert.equal(competing.filter((r) => r.status === 409).length,1);
    const profile = (await api(`/customers/${id}`,{ token })).data;
    assert.equal(profile.network.version,2); assert.equal(profile.network_history.length,2); assert.equal(profile.customer.payment_count,1);
    assert.equal((await api(`/customers/${otherId}`,{ token })).data.network.version,0);
    assert.equal((await api(`/subscriptions?customer_id=${otherId}`,{ token })).data.length,0);
    const reset = await api(`/customers/${id}/speed-override`,{ token,method: 'PUT',body: { version: 2,download_bps: null,upload_bps: null,reason: 'Restore package speeds' } });
    assert.equal(reset.status,200); assert.equal(reset.data.version,3);
    assert.ok((await api(`/subscriptions?customer_id=${id}`,{ token })).data.every((s) => s.desired_download_bps === 5000000 && !s.speed_override));
    console.log('PASS: customer-wide speed precedence, safe retry, optimistic concurrency, audit history, reset and customer isolation');

    const changed = await api(`/packages/${packageId}`,{ token,method: 'PUT',body: { ...offer.data,version: 1,amount_minor: 3000,download_bps: 10000000,upload_bps: 4000000,duration_value: 2 } });
    assert.equal(changed.status,200);
    const newer = await api(`/customers/${id}/complimentary-access`,{ token,body: { ...grant,package_version: 2,request_key: randomUUID() } });
    assert.equal(newer.status,201);
    const activated = await api(`/subscriptions/${simulatedId}/activate-simulation`,{ token,body: { confirm_simulation: true } });
    assert.equal(activated.status,200); const activation = activated.data.activation_at, expiry = activated.data.expires_at;
    assert.equal(new Date(expiry)-new Date(activation),3600000);
    const finalSpeed = await api(`/customers/${id}/speed-override`,{ token,method: 'PUT',body: { version: 3,download_bps: 30000000,upload_bps: 10000000,reason: 'Final test speeds' } });
    assert.equal(finalSpeed.status,200);
    const after = (await api(`/subscriptions?customer_id=${id}`,{ token })).data;
    assert.ok(after.every((s) => s.desired_download_bps === 30000000));
    assert.equal(after.find((s) => s.id === simulatedId).package_snapshot.download_bps,5000000);
    assert.equal(after.find((s) => s.id === newer.data.subscription_id).package_snapshot.download_bps,10000000);
    assert.equal(after.find((s) => s.id === simulatedId).activation_at,activation); assert.equal(after.find((s) => s.id === simulatedId).expires_at,expiry);
    const account = after.find((s) => s.id === simulatedId);
    const session = await api('/sessions/simulation',{ token,body: { action: 'start',account_id: account.account_id,client_ip: '192.0.2.41',client_mac: '02:00:00:00:00:41',router_label: `Free test ${suffix}`,request_key: randomUUID(),confirm_simulation: true } });
    assert.equal(session.status,201);
    const sessionDetail = (await api(`/sessions/${session.data.session_id}`,{ token })).data;
    assert.equal(sessionDetail.session.funding,'complimentary'); assert.equal(sessionDetail.session.customer_id,id);
    assert.equal((await api(`/sessions?customer_id=${id}`,{ token })).data.summary.total,1);
    assert.equal((await api(`/sessions?customer_id=${otherId}`,{ token })).data.summary.total,0);
    assert.equal((await api(`/customers/${id}`,{ token })).data.network_history.length,4);
    const unchanged = (await pool.query('SELECT payment_status,access_status,amount_minor,package_snapshot FROM billing_purchases WHERE id=$1',[purchase.data.id])).rows[0];
    assert.equal(unchanged.payment_status,'pending'); assert.equal(unchanged.access_status,'not_activated'); assert.equal(unchanged.amount_minor,1000); assert.equal(unchanged.package_snapshot.download_bps,5000000);
    assert.equal(account.credentials_issued,false); assert.equal(account.router_id,null);
    console.log('PASS: frozen package terms/dates, overrides on future periods, complimentary simulation/session linkage and unchanged payment/router state');
  } finally {
    for (const token of tokens) await fetch('http://127.0.0.1:3001/api/auth/logout',{ method: 'POST',headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    if (customers.length) {
    if (customers.length) {
      for (const table of ['billing_access_alerts','billing_access_jobs','billing_management_events','billing_renewals','billing_customer_controls','billing_access_policy','billing_customer_devices']) await pool.query('DELETE FROM '+table+' WHERE customer_id=ANY($1::int[])',[customers]);
      await pool.query(`DELETE FROM billing_subscription_runtime WHERE subscription_id IN (SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=ANY($1::int[]))`,[customers]);
    }
      const subs = (await pool.query(`SELECT s.id FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE coalesce(p.customer_id,g.customer_id)=ANY($1::int[])`,[customers])).rows.map((r) => r.id);
      const accounts = (await pool.query('SELECT id FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])',[subs])).rows.map((r) => r.id);
      await pool.query('DELETE FROM billing_session_events WHERE session_id IN (SELECT id FROM billing_sessions WHERE account_id=ANY($1::uuid[]))',[accounts]);
      await pool.query('DELETE FROM billing_sessions WHERE account_id=ANY($1::uuid[])',[accounts]);
      await pool.query('DELETE FROM billing_access_events WHERE subscription_id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_access_accounts WHERE subscription_id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_subscriptions WHERE id=ANY($1::uuid[])',[subs]);
      await pool.query('DELETE FROM billing_access_grants WHERE customer_id=ANY($1::int[])',[customers]);
      await pool.query('DELETE FROM billing_purchases WHERE customer_id=ANY($1::int[])',[customers]);
      await pool.query('DELETE FROM billing_customer_network_events WHERE customer_id=ANY($1::int[])',[customers]);
      await pool.query('DELETE FROM billing_customer_network WHERE customer_id=ANY($1::int[])',[customers]);
      await pool.query('DELETE FROM billing_customers WHERE id=ANY($1::int[])',[customers]);
    }
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1',[packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);
    await pool.end(); console.log('Customer access fixtures removed. No real network or payment operation was used.');
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
