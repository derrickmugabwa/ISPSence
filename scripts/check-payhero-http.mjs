import https from 'node:https';
import assert from 'node:assert/strict';
// Only the loopback development certificate is exempted; no payment is initiated.
function request(path,{ method = 'GET',body,headers = {} } = {}) {
  return new Promise((resolve,reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(`https://127.0.0.1:8443${path}`,{ method,rejectUnauthorized: false,timeout: 15000,headers: { ...headers,...(payload ? { 'Content-Type': 'application/json','Content-Length': Buffer.byteLength(payload) } : {}) } },(res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data',(chunk) => { text += chunk; }); res.on('end',() => { let data; try { data = JSON.parse(text); } catch { /* HTML for proxy-level rejection */ } resolve({ status: res.statusCode,data,headers: res.headers }); });
    });
    req.on('error',reject); req.on('timeout',() => req.destroy(new Error('HTTP check timed out'))); if (payload) req.write(payload); req.end();
  });
}
const availability = await request('/api/public/payhero/availability');
assert.equal(availability.status,200); assert.equal(typeof availability.data.enabled,'boolean');
assert.ok(['sandbox','live'].includes(availability.data.mode)); assert.deepEqual(Object.keys(availability.data).sort(),['enabled','mode']); assert.equal(availability.headers['cache-control'],'no-store');
assert.equal((await request('/api/billing/payhero/settings')).status,401);
assert.equal((await request('/api/public/payhero/checkouts/00000000-0000-4000-8000-000000000000')).status,404);
const callback = `/api/payhero/callback/00000000-0000-4000-8000-000000000000/${'0'.repeat(64)}`;
assert.equal((await request(callback,{ method: 'POST',body: {} })).status,404);
assert.equal((await request(callback)).status,404);
assert.equal((await request(callback,{ method: 'POST',body: { extra: 'x'.repeat(17000) } })).status,413);
console.log(`PASS: PayHero HTTP availability (${availability.data.enabled ? 'enabled' : 'disabled'}), secret-free public response, admin authentication, checkout privacy and bounded callback routes`);
console.log('No provider request, collection or router action was initiated.');
