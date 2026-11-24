// Local integration check. Temporary fixtures are cleaned; audit traces remain.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');

async function main() {
  const suffix = randomUUID().slice(0, 12);
  const users = [], sessions = [], keys = [];
  let customerId, packageId;
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:3001/api${path}`, {
      method, signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const dbError = async (sql, values, code) => {
    let actual;
    try { await pool.query(sql, values); } catch (error) { actual = error.code; }
    assert.equal(actual, code);
  };
  try {
    assert.equal((await api('/billing/customers')).status, 401);
    assert.equal((await api('/billing/payments')).status, 401);
    for (const role of ['admin','viewer','operator']) {
      const username = `billcheck_${role}_${suffix}`, password = randomUUID();
      const hash = await bcrypt.hash(password, 12);
      const row = await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id', [username, hash, role]);
      users.push(row.rows[0].id);
      const login = await api('/auth/login', { method: 'POST', body: { username, password } });
      assert.equal(login.status, 200); sessions.push({ role, token: login.data.token });
    }
    for (const s of sessions.filter((s) => s.role !== 'admin')) {
      for (const path of ['/billing/customers','/billing/payments']) {
        assert.equal((await api(path, { token: s.token })).status, 403);
        assert.equal((await api(path, { method: 'POST', token: s.token, body: {} })).status, 403);
      }
    }
    const token = sessions.find((s) => s.role === 'admin').token;
    const customerBody = { full_name: `Billing fixture ${suffix}`, phone: '0712345678', notes: 'Temporary integration fixture' };
    const customer = await api('/billing/customers', { method: 'POST', token, body: customerBody });
    assert.equal(customer.status, 201); customerId = customer.data.id;
    assert.equal(customer.data.phone, '+254712345678');
    const renamed = await api(`/billing/customers/${customerId}`, { method: 'PUT', token, body: { ...customerBody, full_name: `${customerBody.full_name} edited`, version: 1 } });
    assert.equal(renamed.status, 200); assert.equal(renamed.data.version, 2);
    assert.equal((await api(`/billing/customers/${customerId}`, { method: 'PUT', token, body: { ...customerBody, version: 1 } })).status, 409);
    console.log('PASS: real customer persistence, normalized phone, edit version and financial-data permissions');
    const offer = { name: `Billing offer ${suffix}`, amount_minor: 5000, currency: 'KES', duration_value: 1,
      duration_unit: 'day', download_bps: 5000000, upload_bps: 2000000, allowance_bytes: null, enabled: true };
    const createdOffer = await api('/billing/packages', { method: 'POST', token, body: offer });
    assert.equal(createdOffer.status, 201); packageId = createdOffer.data.id;
    const requestKey = randomUUID(); keys.push(requestKey);
    const body = { customer_id: customerId, package_id: packageId, package_version: 1, payer_phone: '0711223344', request_key: requestKey, amount_minor: 1 };
    const responses = await Promise.all(Array.from({ length: 5 }, () => api('/billing/payments', { method: 'POST', token, body })));
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.ok(responses.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
    const payment = responses[0].data;
    assert.equal(payment.amount_minor, 5000); assert.equal(payment.payer_phone, '+254711223344');
    assert.equal(payment.payment_status, 'pending'); assert.equal(payment.access_status, 'not_activated');
    assert.equal((await api('/billing/payments', { method: 'POST', token, body: { ...body, payer_phone: '0711334455' } })).status, 409);
    assert.equal((await api('/billing/payments', { method: 'POST', token, body: { ...body, payment_status: 'paid' } })).status, 400);
    console.log('PASS: concurrent retries produce one pending record; payer is separate; client price/status cannot override server terms');
    const changed = await api(`/billing/packages/${packageId}`, { method: 'PUT', token, body: { ...offer, amount_minor: 7000, download_bps: 9000000, version: 1 } });
    assert.equal(changed.status, 200);
    const replay = await api('/billing/payments', { method: 'POST', token, body });
    assert.equal(replay.status, 200); assert.equal(replay.data.package_snapshot.download_bps, 5000000); assert.equal(replay.data.amount_minor, 5000);
    const secondKey = randomUUID(); keys.push(secondKey);
    assert.equal((await api('/billing/payments', { method: 'POST', token, body: { ...body, request_key: secondKey } })).status, 409);
    assert.equal((await api(`/billing/packages/${packageId}/status`, { method: 'PATCH', token, body: { enabled: false, version: 2 } })).status, 200);
    assert.equal((await api('/billing/payments', { method: 'POST', token, body: { ...body, request_key: secondKey, package_version: 3 } })).status, 422);
    await dbError('UPDATE billing_purchases SET amount_minor=1 WHERE id=$1', [payment.id], '23514');
    await dbError('DELETE FROM billing_customers WHERE id=$1', [customerId], '23503');
    const history = await api(`/billing/payments?customer_id=${customerId}`, { token });
    assert.equal(history.status, 200); assert.equal(history.data.length, 1);
    assert.equal(history.data[0].package_snapshot.name, offer.name);
    assert.equal(history.data[0].customer_name, renamed.data.full_name);
    const directory = await api('/billing/customers', { token });
    assert.equal(directory.data.find((c) => c.id === customerId).payment_count, 1);
    console.log('PASS: frozen terms, stale/disabled offer rejection, immutable database record, linked customer history');
  } finally {
    for (const s of sessions) await api('/auth/logout', { method: 'POST', token: s.token }).catch(() => {});
    if (keys.length) await pool.query('DELETE FROM billing_purchases WHERE request_key=ANY($1::uuid[])', [keys]);
    if (customerId) await pool.query('DELETE FROM billing_customers WHERE id=$1', [customerId]);
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1', [packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
    await pool.end();
    console.log('Temporary billing and staff fixtures removed; no charges or router commands issued.');
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
