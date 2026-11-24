import assert from 'node:assert/strict';
import https from 'node:https';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://127.0.0.1:8443${path}`, { rejectUnauthorized: false, timeout: 15000 }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Local docs check timed out')));
  });
}

for (const path of ['/docs', '/docs/pppoe', '/docs/change-guard']) assert.equal((await get(path)).status, 200);
const page = await get('/docs');
const entry = page.body.match(/src="([^"]+\.js)"/)?.[1]; assert.ok(entry);
const main = await get(entry); assert.equal(main.status, 200);
const docsChunk = main.body.match(/DocsPage-[\w-]+\.js/)?.[0]; assert.ok(docsChunk, 'Lazy documentation bundle missing');
const docs = await get(`/assets/${docsChunk}`); assert.equal(docs.status, 200);
assert.ok(docs.body.includes('Get started with ISPSense'));
assert.ok(docs.body.includes('Feature readiness'));
assert.ok(docs.body.includes('production RADIUS authorization gate remains blocked'));
console.log('PASS: deployed docs and deep links load without authentication; lazy bundle contains product guides and readiness boundaries');
