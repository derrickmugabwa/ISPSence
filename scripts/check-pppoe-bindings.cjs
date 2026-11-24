const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function checkBindings(pool,serviceId) {
  const { saveServiceBinding } = require('/app/dist/modules/billing/serviceBindings');
  const { listCustomerServices } = require('/app/dist/modules/billing/customerServices');
  await pool.query("INSERT INTO devices(id,name) VALUES(987,'Fictional test router')");
  const version = (await pool.query('SELECT version FROM billing_customer_services WHERE id=$1',[serviceId])).rows[0].version;
  const credentialsBefore = (await pool.query('SELECT * FROM billing_service_credentials WHERE service_id=$1',[serviceId])).rows;
  const periodsBefore = (await pool.query('SELECT * FROM billing_subscriptions ORDER BY id')).rows;
  const inventory = { ros_version: '6.49.18',servers: [{ id: '*1',service_name: 'Internet',interface: 'vlan20',default_profile: 'home',disabled: false,authentication: ['pap','chap'] }],profiles: [{ name: 'home',local_address: '10.0.0.1',remote_address: 'pool' }],pools: [{ name: 'pool',ranges: '10.0.0.2-10.0.0.254' }],radius_enabled: false,ppp_radius_clients: 0,local_username_collision: false };
  const discover = async (v,changes={}) => {
    const id=randomUUID();
    await pool.query('INSERT INTO billing_pppoe_discoveries(id,service_id,device_id,service_version,inventory) VALUES($1,$2,987,$3,$4)',[id,serviceId,v,JSON.stringify({...inventory,...changes})]);
    return id;
  };
  const input = { version,discovery_id: await discover(version),server_id: '*1',profile_name: 'home',pool_name: 'pool',cpe_mac: '02:00:00:00:00:01',reason: 'Fixture binding',request_key: randomUUID() };
  const results = await Promise.all(Array.from({length:6},()=>saveServiceBinding(serviceId,input,'fixture')));
  assert.equal(results.filter(r=>!r.replayed).length,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM billing_service_bindings')).rows[0].n,1);
  assert.equal(results[0].service.binding.status,'pending');
  assert.equal(results[0].service.binding.router_name,'Fictional test router');
  const changed = { ...input,version: version+1,discovery_id: await discover(version+1),request_key: randomUUID() };
  const conflict = { ...changed,request_key: randomUUID(),reason: 'Concurrent different action' };
  const race = await Promise.allSettled([saveServiceBinding(serviceId,changed,'fixture'),saveServiceBinding(serviceId,conflict,'fixture')]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.filter(r=>r.status==='rejected' && r.reason.status===409).length,1);
  await assert.rejects(saveServiceBinding(serviceId,{ ...input,reason: 'Changed replay' },'fixture'),e=>e.status===409);
  // Replay of an older operation must not restore its old binding/version.
  const replay=await saveServiceBinding(serviceId,input,'fixture');
  assert.equal(replay.replayed,true); assert.equal(replay.service.version,version+2);
  const stale = { ...input,version: version+2,request_key: randomUUID() };
  await assert.rejects(saveServiceBinding(serviceId,stale,'fixture'),e=>e.status===409);
  const expiredId = randomUUID();
  await pool.query("INSERT INTO billing_pppoe_discoveries(id,service_id,device_id,service_version,inventory,created_at,expires_at) VALUES($1,$2,987,$3,$4,now()-interval '20 minutes',now()-interval '10 minutes')",[expiredId,serviceId,version+2,JSON.stringify(inventory)]);
  await assert.rejects(saveServiceBinding(serviceId,{...stale,discovery_id:expiredId},'fixture'),e=>e.status===409);
  await assert.rejects(saveServiceBinding(serviceId,{...stale,discovery_id:await discover(version+2,{local_username_collision:true})},'fixture'),e=>e.status===409);
  const other=(await pool.query('SELECT id FROM billing_customer_services WHERE customer_id<>1 LIMIT 1')).rows[0];
  await assert.rejects(saveServiceBinding(other.id,{...stale,discovery_id:await discover(version+2)},'fixture'),e=>e.status===409);
  await assert.rejects(pool.query('DELETE FROM billing_service_bindings WHERE service_id=$1',[serviceId]),e=>e.code==='23514');
  await assert.rejects(pool.query("UPDATE billing_pppoe_discoveries SET inventory='{}' WHERE id=$1",[input.discovery_id]),e=>e.code==='23514');
  assert.deepEqual((await pool.query('SELECT * FROM billing_service_credentials WHERE service_id=$1',[serviceId])).rows,credentialsBefore);
  assert.deepEqual((await pool.query('SELECT * FROM billing_subscriptions ORDER BY id')).rows,periodsBefore);
  assert.equal((await listCustomerServices(1)).find(s=>s.id===serviceId).binding.pool_name,'pool');
  console.log('PASS: concurrent/idempotent pending router assignment, stale/expired discovery and local-conflict rejection, immutable history, credentials and paid timestamps preserved');
};
