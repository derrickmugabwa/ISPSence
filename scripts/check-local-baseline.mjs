import assert from 'node:assert/strict';
import https from 'node:https';

// Only the loopback development certificate is exempt from CA validation.
const origin = 'https://127.0.0.1:8443';
function request(path, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, origin), {
      method,
      rejectUnauthorized: false,
      timeout: 15000,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { /* HTML or empty response */ }
        resolve({ status: res.statusCode, text, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Local baseline request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

const health = await request('/api/health');
assert.equal(health.status, 200);
assert.equal(health.data.status, 'ok');
console.log('PASS: HTTPS API health');

const page = await request('/login');
assert.equal(page.status, 200);
assert.match(page.text, /<div id="root"><\/div>/);
const assetPath = page.text.match(/src="([^"]+\.js)"/)?.[1];
assert.ok(assetPath?.startsWith('/assets/'), 'Compiled application script missing');
const asset = await request(assetPath);
assert.equal(asset.status, 200);
assert.ok(asset.text.length > 1000);
console.log('PASS: compiled frontend and application script served');

const denied = await request('/api/devices');
assert.equal(denied.status, 401);
console.log('PASS: device API requires authentication');

const internal = await request('/internal/radius/accounting', { method: 'POST', body: {} });
assert.equal(internal.status, 404);
console.log('PASS: private RADIUS bridge is not proxied by nginx');

const hints = await request('/api/auth/login-hints');
assert.equal(hints.status, 200);
if (hints.data.default_credentials) {
  const login = await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  assert.equal(login.data.user.must_change_password, true);
  const token = login.data.token;
  const me = await request('/api/auth/me', { token });
  assert.equal(me.status, 200);
  const restricted = await request('/api/devices', { token });
  assert.equal(restricted.status, 403);
  assert.equal(restricted.data.code, 'password_change_required');
  console.log('PASS: database-backed admin login, session validation and mandatory password change');
  const logout = await request('/api/auth/logout', { method: 'POST', token });
  assert.equal(logout.status, 200);
  const revoked = await request('/api/auth/me', { token });
  assert.equal(revoked.status, 401);
  console.log('PASS: logout revokes session');
} else {
  console.log('SKIP: initial-admin checks; default password already changed (no credentials requested)');
}
console.log('Local baseline checks complete. No router or payment operation was requested.');
