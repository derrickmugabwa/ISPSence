import assert from 'node:assert/strict';
import https from 'node:https';
function get(path,method = 'GET') {
  return new Promise((resolve,reject) => {
    const req = https.request(`https://127.0.0.1:8443${path}`,{ method,rejectUnauthorized: false,timeout: 15000 },(res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data',(chunk) => body += chunk); res.on('end',() => resolve({ status: res.statusCode,body }));
    }); req.on('error',reject); req.on('timeout',() => req.destroy(new Error('Local HTTP check timed out'))); req.end();
  });
}
assert.equal((await get('/api/health')).status,200);
assert.equal((await get('/api/billing/dashboard?start=2025-01-01&end=2025-01-01')).status,401);
assert.equal((await get('/api/billing/payments/00000000-0000-4000-8000-000000000001/manual-receipt','POST')).status,401);
const page = await get('/dashboard'); assert.equal(page.status,200);
const assetPath = page.body.match(/src="([^"]+\.js)"/)?.[1]; assert.ok(assetPath);
const asset = await get(assetPath); assert.equal(asset.status,200); assert.ok(asset.body.includes('Collected · selected period')); assert.ok(!asset.body.includes('billing-overview-toolbar'));
assert.ok(asset.body.includes('Configure FUP')); assert.ok(asset.body.includes('Fair usage policy'));
assert.equal((await get('/api/billing/customers/1/fup')).status,401);
assert.equal((await get('/api/billing/radius/pipeline')).status,401);
assert.equal((await get('/internal/radius/observations','POST')).status,404);
assert.ok(!asset.body.includes('Billing data environment')); assert.ok(!asset.body.includes('New test session')); assert.ok(asset.body.includes('No session data yet'));
console.log('PASS: local API health, financial endpoint authentication and deployed billing dashboard assets');
