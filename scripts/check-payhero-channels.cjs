// Disposable PostgreSQL schema, injected fictional provider. No real PayHero calls.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
async function main() {
  const schema = `payhero_channels_${randomUUID().replace(/-/g,'')}`;
  assert.match(schema,/^payhero_channels_[a-f0-9]{32}$/);
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.DB_PASSWORD) url.password = encodeURIComponent(process.env.DB_PASSWORD);
  const control = new Pool({ connectionString: url.toString(),options: '-c search_path=public' });
  let pool;
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    ({ pool } = require('/app/dist/config/database'));
    assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s,schema);
    await pool.query('CREATE TABLE billing_purchases(id UUID PRIMARY KEY,amount_minor INTEGER,payment_status TEXT); CREATE TABLE billing_portals(id INTEGER PRIMARY KEY)');
    await pool.query(require('/app/dist/modules/billing/payheroSchema').PAYHERO_SCHEMA);
    const { registerPayHeroBank } = require('/app/dist/modules/billing/payheroChannels');
    const bank = { id: 'qa-bank',name: 'Sample Bank',paybill: '522522' };
    const body = { connection: { version: 0,mode: 'sandbox',base_url: 'https://backend.payhero.co.ke',username: 'fixture',password: 'fixture-secret' },bank_id: bank.id,account_id: 5000,account_number: '001234567',description: 'Sample destination',request_key: randomUUID() };
    const channels = []; let posts = 0, loseReply = false;
    const transport = async (url,options) => {
      if (options.method === 'POST') {
        posts++;
        const sent = JSON.parse(options.body);
        const channel = { ...sent,id: 100+posts,short_code: String(sent.short_code),is_active: true };
        channels.push(channel);
        if (loseReply) throw new Error('Fictional lost reply');
        return new Response(JSON.stringify(channel));
      }
      return new Response(JSON.stringify(String(url).includes('bank_paybills') ? { bank_paybills: [bank] } : { payment_channels: channels,pagination: { next_page: null } }));
    };
    const outcomes = await Promise.allSettled([registerPayHeroBank(body,'fixture',transport),registerPayHeroBank(body,'fixture',transport)]);
    assert.ok(outcomes.some((r) => r.status === 'fulfilled')); assert.equal(posts,1,'Concurrent registration sent duplicate POST');
    assert.equal((await registerPayHeroBank(body,'fixture',transport)).channel.account_number,'001234567'); assert.equal(posts,1);
    console.log('PASS: PostgreSQL concurrent claims, duplicate prevention and leading account zeros');
    loseReply = true;
    const interrupted = { ...body,account_number: '00098765',request_key: randomUUID() };
    await assert.rejects(registerPayHeroBank(interrupted,'fixture',transport),{ status: 502 });
    assert.equal((await registerPayHeroBank(interrupted,'fixture',transport)).channel.account_number,'00098765'); assert.equal(posts,2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_payhero_channel_registrations WHERE state='confirmed'")).rows[0].n,2);
    console.log('PASS: durable uncertain registration recovers without a second provider POST');
    assert.equal((await pool.query('SELECT config_id FROM billing_payhero_settings WHERE id=1')).rows[0].config_id,null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_payhero_attempts')).rows[0].n,0);
    console.log('PASS: registration does not change collection settings or create a payment');
  } finally {
    if (pool) await pool.end();
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
