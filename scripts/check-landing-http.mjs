import assert from 'node:assert/strict';
import https from 'node:https';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://127.0.0.1:8443${path}`, { rejectUnauthorized: false, timeout: 15000 }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Local landing check timed out')));
  });
}
const root = await get('/'); assert.equal(root.status, 200);
const entryPath = root.body.match(/src="([^"]+\.js)"/)?.[1]; assert.ok(entryPath);
const entry = await get(entryPath); assert.equal(entry.status, 200);
const chunk = entry.body.match(/LandingPage-[\w-]+\.js/)?.[0]; assert.ok(chunk, 'Landing route must have its own lazy bundle');
const landing = await get(`/assets/${chunk}`); assert.equal(landing.status, 200);
assert.ok(landing.body.includes('The control centre'));
assert.ok(!landing.body.includes('Fictional records, no live customer data'));
assert.ok(!landing.body.includes('Try the tabs and customer names'));
assert.ok(landing.body.includes('lp-mobile-navigation'));
const cssChunk = entry.body.match(/LandingPage-[\w-]+\.css/)?.[0]; assert.ok(cssChunk);
const css = await get(`/assets/${cssChunk}`); assert.equal(css.status, 200);
assert.ok(css.body.includes('Outfit')); assert.ok(css.body.includes('font-feature-settings:normal'));
assert.ok(css.body.includes('prefers-reduced-motion')); assert.ok(css.body.includes('clip-path:polygon'));
assert.equal((await get('/docs')).status, 200);
assert.equal((await get('/workspace')).status, 200);
assert.equal((await get('/api/billing/customers')).status, 401);
assert.equal((await get('/api/billing/radius/pipeline')).status, 401);
console.log('PASS: public landing assets, distinct design stylesheet, docs/workspace deep links and protected customer APIs');
