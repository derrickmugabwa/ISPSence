const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');

async function main() {
  const r = (await pool.query("SELECT * FROM billing_radius_records WHERE username='radius-lab' AND nas_identifier='private-lab' ORDER BY last_received_at DESC LIMIT 1")).rows[0];
  assert.ok(r,'Run check-billing-lab in the radius-lab container first');
  assert.equal(r.lab,true); assert.equal(r.start_seen,true); assert.equal(r.stop_seen,true);
  assert.equal(Number(r.elapsed_seconds),120); assert.equal(Number(r.download_bytes),90000); assert.equal(Number(r.upload_bytes),20000);
  const packets = (await pool.query('SELECT * FROM billing_radius_packets WHERE record_id=$1',[r.id])).rows;
  assert.equal(packets.length,4,'Identical interim retransmission must be deduplicated');
  assert.equal(packets.filter((p) => p.kind === 'Stop').length,1);
  assert.ok(packets.every((p) => p.event_at),'FreeRADIUS date attributes must be preserved');
  const endpoint = 'http://127.0.0.1:3001/internal/radius';
  const call = (path,body,auth) => fetch(`${endpoint}/${path}`,{ method: 'POST',headers: { 'Content-Type': 'application/json',...(auth ? { Authorization: `Bearer ${auth}` } : {}) },body: JSON.stringify(body) });
  assert.equal((await call('accounting',{})).status,401);
  assert.equal((await call('authorize',{},process.env.RADIUS_BRIDGE_TOKEN)).status,403);
  const attr = (value) => ({ value: [value],type: 'string' });
  assert.equal((await call('accounting',{ 'Tmp-IP-Address-0': attr('192.0.2.10'),'Acct-Status-Type': attr('Start'),'User-Name': attr('radius-lab'),'Acct-Session-Id': attr('forged-source') },process.env.RADIUS_BRIDGE_TOKEN)).status,403);
  assert.equal((await fetch('http://127.0.0.1:3001/api/billing/radius')).status,401);
  const username = `radius_check_${randomUUID().slice(0,12)}`, password = randomUUID();
  const userId = (await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,await bcrypt.hash(password,12),'admin'])).rows[0].id;
  let token;
  try {
    const login = await fetch('http://127.0.0.1:3001/api/auth/login',{ method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ username,password }) });
    assert.equal(login.status,200); token = (await login.json()).token;
    const page = await fetch('http://127.0.0.1:3001/api/billing/radius',{ headers: { Authorization: `Bearer ${token}` } });
    assert.equal(page.status,200); const data = await page.json();
    assert.equal(data.configured,true); assert.equal(data.live_authorization,false);
    assert.ok(data.records.some((record) => record.id === r.id && record.lab && record.stop_seen));
    assert.equal(JSON.stringify(data).includes(process.env.RADIUS_BRIDGE_TOKEN),false);
  } finally {
    if (token) await fetch('http://127.0.0.1:3001/api/auth/logout',{ method: 'POST',headers: { Authorization: `Bearer ${token}` } });
    await pool.query('DELETE FROM users WHERE id=$1',[userId]);
  }
  console.log('PASS: RADIUS packets persisted exactly once; direction and cumulative counters correct; late update did not reopen the stopped lab record');
  console.log('PASS: bridge authentication, unenrolled-source rejection, denied customer admission, and authenticated dashboard diagnostics without secret exposure');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
