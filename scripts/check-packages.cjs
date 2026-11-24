// Execute through the running backend's Node runtime; never prints credentials.
// Get-Content -Raw scripts/check-packages.cjs | docker compose ... exec -T backend node
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');

async function main() {
  const suffix = randomUUID().slice(0, 12);
  const users = [];
  const sessions = [];
  let packageId;
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:3001/api${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await api('/billing/packages')).status, 401);
    for (const role of ['admin','viewer','operator']) {
      const username = `pkgcheck_${role}_${suffix}`;
      const password = randomUUID();
      const hash = await bcrypt.hash(password, 12);
      const row = await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id', [username, hash, role]);
      users.push(row.rows[0].id);
      const login = await api('/auth/login', { method: 'POST', body: { username, password } });
      assert.equal(login.status, 200, `Temporary ${role} login failed`);
      assert.ok(login.data.token);
      sessions.push({ role, token: login.data.token });
    }
    const admin = sessions.find((s) => s.role === 'admin').token;
    const body = { name: `Package check ${suffix}`, amount_minor: 1234, currency: 'KES', duration_value: 1,
      duration_unit: 'day', download_bps: 1500000, upload_bps: 1000000, allowance_bytes: null, enabled: true };
    for (const session of sessions.filter((s) => s.role !== 'admin')) {
      assert.equal((await api('/billing/packages', { token: session.token })).status, 200);
      assert.equal((await api('/billing/packages', { method: 'POST', token: session.token, body })).status, 403);
    }
    console.log('PASS: real authentication and read/write permissions');
    const created = await api('/billing/packages', { method: 'POST', token: admin, body });
    assert.equal(created.status, 201);
    packageId = created.data.id;
    assert.equal(created.data.download_bps, 1500000);
    assert.equal(created.data.allowance_bytes, null);
    const stored = await pool.query('SELECT amount_minor FROM billing_packages WHERE id=$1', [packageId]);
    assert.equal(stored.rows[0].amount_minor, 1234);
    assert.equal((await api('/billing/packages', { method: 'POST', token: admin, body: { ...body, name: body.name.toUpperCase() } })).status, 409);
    console.log('PASS: persisted exact KES price, numeric speed serialization, unlimited cap, unique name');
    const edited = await api(`/billing/packages/${packageId}`, { method: 'PUT', token: admin,
      body: { ...body, duration_unit: 'calendar_month', allowance_bytes: 5000000000, version: 1 } });
    assert.equal(edited.status, 200); assert.equal(edited.data.version, 2);
    assert.equal(edited.data.duration_unit, 'calendar_month'); assert.equal(edited.data.allowance_bytes, 5000000000);
    assert.equal((await api(`/billing/packages/${packageId}`, { method: 'PUT', token: admin, body: { ...body, version: 1 } })).status, 409);
    const disabled = await api(`/billing/packages/${packageId}/status`, { method: 'PATCH', token: admin, body: { enabled: false, version: 2 } });
    assert.equal(disabled.status, 200); assert.equal(disabled.data.enabled, false);
    const enabled = await api(`/billing/packages/${packageId}/status`, { method: 'PATCH', token: admin, body: { enabled: true, version: 3 } });
    assert.equal(enabled.status, 200); assert.equal(enabled.data.enabled, true);
    assert.equal((await api('/billing/packages', { method: 'POST', token: admin, body: { ...body, name: 'Invalid fixture', amount_minor: -1 } })).status, 400);
    assert.equal((await api('/billing/packages', { method: 'POST', token: admin, body: { ...body, duration_unit: ['hour'] } })).status, 400);
    const listed = await api('/billing/packages', { token: admin });
    assert.equal(listed.data.find((p) => p.id === packageId).allowance_bytes, 5000000000);
    console.log('PASS: edit, calendar month, capped data, stale-version conflict, disable/enable and invalid-input rejection');
  } finally {
    for (const session of sessions) await api('/auth/logout', { method: 'POST', token: session.token }).catch(() => {});
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1', [packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
    await pool.end();
    console.log('Temporary package and staff accounts removed. Audit records retained.');
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
