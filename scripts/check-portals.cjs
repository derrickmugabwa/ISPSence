const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('/app/dist/config/database');

async function main() {
  const users = [], portals = [], tokens = [], suffix = randomUUID().slice(0,8);
  let packageId;
  const api = async (path,{ token,body,method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`http://127.0.0.1:3001/api${path}`,{ method,signal: AbortSignal.timeout(20000),headers: { 'Content-Type': 'application/json',...(token ? { Authorization: `Bearer ${token}` } : {}) },...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status,data: await response.json(),cache: response.headers.get('Cache-Control') };
  };
  const ok = (r,status = 200) => { assert.equal(r.status,status,JSON.stringify(r.data)); return r.data; };
  try {
    for (const role of ['admin','viewer']) {
      const username = `portal_${role}_${suffix}`, password = randomUUID();
      users.push((await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,await bcrypt.hash(password,12),role])).rows[0].id);
      const login = await fetch('http://127.0.0.1:3001/api/auth/login',{ method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ username,password }) });
      assert.equal(login.status,200); tokens.push((await login.json()).token);
    }
    const [token,viewer] = tokens;
    assert.equal((await api('/billing/portals')).status,401);
    assert.equal((await api('/billing/portals',{ token: viewer })).status,403);
    const templates = ok(await api('/billing/portals/templates',{ token })); assert.equal(templates.length,3);
    const offer = ok(await api('/billing/packages',{ token,body: { name: `Portal package ${suffix}`,amount_minor: 5000,currency: 'KES',duration_value: 1,duration_unit: 'day',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,enabled: true } }),201); packageId = offer.id;
    for (const template of templates) {
      const slug = `portal-${suffix}-${template.id}`;
      const config = { ...template.default_config,package_display: { name: true,price: true,duration: false,download_speed: false,upload_speed: true,data_allowance: false },brand_name: `Sample Wi-Fi ${suffix}`,headline: 'Original public heading',support_phone: '+254 712 345 678',terms_text: 'Sample terms',package_ids: [packageId] };
      const p = ok(await api('/billing/portals',{ token,body: { name: `Private editor name ${suffix}`,slug,config } }),201); portals.push(p.id);
      assert.equal(p.published_config,null);
      assert.equal((await api(`/public/portals/${slug}`)).status,404);
      assert.equal((await api('/billing/portals',{ token,body: { name: 'Duplicate',slug,config } })).status,409);
      assert.equal((await api(`/billing/portals/${p.id}/publish`,{ token: viewer,body: { version: 1 } })).status,403);
      let current = ok(await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 1 } }));
      assert.equal(current.version,2); assert.equal(current.published_version,1);
      const visible = await api(`/public/portals/${slug}`); ok(visible); assert.equal(visible.cache,'no-store');
      assert.equal(visible.data.config.template,template.id); assert.equal(visible.data.config.headline,config.headline);
      assert.deepEqual(visible.data.config.package_display,config.package_display);
      assert.equal(visible.data.connection_available,false); assert.equal(visible.data.packages.length,1);
      assert.equal(visible.data.packages[0].amount_minor,5000); assert.equal(typeof visible.data.packages[0].download_bps,'number');
      assert.ok(!JSON.stringify(visible.data).includes('Private editor name')); assert.ok(!('history' in visible.data)); assert.ok(!('actor' in visible.data));
      current = ok(await api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { name: current.name,version: 2,config: { ...config,headline: 'Draft changes only',package_display: { ...config.package_display,duration: true } } } }));
      assert.deepEqual(current.draft_config.package_display,{ ...config.package_display,duration: true });
      assert.deepEqual(ok(await api(`/public/portals/${slug}`)).config.package_display,config.package_display);
      assert.equal(current.version,3); assert.equal(current.published_config.headline,'Original public heading');
      assert.equal(ok(await api(`/public/portals/${slug}`)).config.headline,'Original public heading');
      assert.equal((await api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { name: current.name,version: 2,config } })).status,409);
      const competing = await Promise.all(['First editor','Second editor'].map((headline) => api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { name: current.name,version: 3,config: { ...config,headline } } })));
      assert.equal(competing.filter((r) => r.status === 200).length,1); assert.equal(competing.filter((r) => r.status === 409).length,1);
      const winner = competing.find((r) => r.status === 200).data;
      current = ok(await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 4 } })); assert.equal(current.version,5);
      assert.equal(ok(await api(`/public/portals/${slug}`)).config.headline,winner.draft_config.headline);
      assert.equal(current.history.filter((e) => e.kind === 'published').length,2);
      current = ok(await api(`/billing/portals/${p.id}/unpublish`,{ token,body: { version: 5 } }));
      assert.equal(current.version,6); assert.equal(current.published_config,null); assert.equal(current.draft_config.headline,winner.draft_config.headline);
      assert.equal((await api(`/public/portals/${slug}`)).status,404);
    }
    console.log('PASS: three layouts, configurable package fields, admin permissions, public/draft isolation, immutable URLs, publication history, concurrent editor protection and unpublishing');
    const config = { ...templates[0].default_config,package_ids: [packageId] }, slug = `catalog-${suffix}`;
    let p = ok(await api('/billing/portals',{ token,body: { name: `Catalog fixture ${suffix}`,slug,config } }),201); portals.push(p.id);
    assert.equal((await api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { version: 1,name: p.name,config: { ...config,primary_color: 'url(javascript:alert(1))' } } })).status,400);
    assert.equal((await api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { version: 1,name: p.name,config: { ...config,logo_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } } })).status,400);
    assert.equal((await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 1,config } })).status,400);
    p = ok(await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 1 } }));
    ok(await api(`/billing/packages/${packageId}/status`,{ token,method: 'PATCH',body: { version: 1,enabled: false } }));
    assert.equal(ok(await api(`/public/portals/${slug}`)).packages.length,0);
    assert.equal((await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 2 } })).status,409);
    p = ok(await api(`/billing/portals/${p.id}`,{ token,method: 'PUT',body: { version: 2,name: p.name,config: { ...config,show_packages: false } } }));
    ok(await api(`/billing/portals/${p.id}/publish`,{ token,body: { version: 3 } }));
    assert.deepEqual(ok(await api(`/public/portals/${slug}`)).packages,[]);
    console.log('PASS: disabled packages never exposed, hidden catalogs, server-controlled publication, and rejected unsafe colors/SVG logos');
  } finally {
    for (const token of tokens) await fetch('http://127.0.0.1:3001/api/auth/logout',{ method: 'POST',headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    if (portals.length) {
      await pool.query('DELETE FROM billing_portal_events WHERE portal_id=ANY($1::int[])',[portals]);
      await pool.query('DELETE FROM billing_portals WHERE id=ANY($1::int[])',[portals]);
    }
    if (packageId) await pool.query('DELETE FROM billing_packages WHERE id=$1',[packageId]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);
    await pool.end(); console.log('Portal fixtures removed. No customer sign-in, payment collection or router configuration was performed.');
  }
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
