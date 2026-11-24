// Tests migration and permanent customer codes in a disposable schema only.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
async function main() {
  const schema = `customer_codes_${randomUUID().replace(/-/g,'')}`;
  assert.match(schema,/^customer_codes_[a-f0-9]{32}$/);
  const url = new URL(process.env.DATABASE_URL); if (process.env.DB_PASSWORD) url.password = encodeURIComponent(process.env.DB_PASSWORD);
  const control = new Pool({ connectionString: url.toString(),options: '-c search_path=public' }); let pool;
  try {
    await control.query(`CREATE SCHEMA "${schema}"`); process.env.PGOPTIONS = `-c search_path=${schema}`;
    ({ pool } = require('/app/dist/config/database'));
    assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s,schema);
    await pool.query(require('/app/dist/modules/billing/packages').PACKAGE_SCHEMA);
    await pool.query(`CREATE TABLE billing_customers(id SERIAL PRIMARY KEY,full_name VARCHAR(100) NOT NULL,phone VARCHAR(16),notes VARCHAR(1000) NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO billing_customers(id,full_name) VALUES(42,'Existing customer')`);
    const { CUSTOMERS_PAYMENTS_SCHEMA } = require('/app/dist/modules/billing/customersPayments');
    await pool.query(CUSTOMERS_PAYMENTS_SCHEMA);
    let existing = (await pool.query('SELECT * FROM billing_customers WHERE id=42')).rows[0];
    assert.equal(existing.customer_code,'CUS-000042');
    const created = await Promise.all(Array.from({ length: 20 },(_,i) => pool.query('INSERT INTO billing_customers(full_name) VALUES($1) RETURNING id,customer_code',[`Concurrent customer ${i}`])));
    const codes = created.map((r) => r.rows[0].customer_code);
    assert.equal(new Set(codes).size,20); assert.ok(codes.every((code) => /^CUS-\d{6}$/.test(code)));
    assert.equal((await pool.query("INSERT INTO billing_customers(id,full_name) VALUES(1000000,'Large ID') RETURNING customer_code")).rows[0].customer_code,'CUS-1000000');
    console.log('PASS: existing customers backfilled, concurrent inserts unique, large IDs never truncated');
    await pool.query("UPDATE billing_customers SET full_name='Updated name',phone='+254712345678',version=version+1 WHERE id=42");
    existing = (await pool.query('SELECT * FROM billing_customers WHERE id=42')).rows[0]; assert.equal(existing.customer_code,'CUS-000042');
    await assert.rejects(pool.query("UPDATE billing_customers SET customer_code='CUS-999999' WHERE id=42"),{ code: '428C9' });
    await assert.rejects(pool.query('UPDATE billing_customers SET id=123456 WHERE id=42'),{ code: '23514' });
    await assert.rejects(pool.query("INSERT INTO billing_customers(full_name,customer_code) VALUES('Spoofed','CUS-000042')"),{ code: '428C9' });
    const before = (await pool.query('SELECT id,customer_code FROM billing_customers ORDER BY id')).rows;
    await pool.query(CUSTOMERS_PAYMENTS_SCHEMA);
    assert.deepEqual((await pool.query('SELECT id,customer_code FROM billing_customers ORDER BY id')).rows,before);
    console.log('PASS: permanent codes survive contact edits and repeat migrations; manual codes and identity changes are rejected');
  } finally { if (pool) await pool.end(); await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
