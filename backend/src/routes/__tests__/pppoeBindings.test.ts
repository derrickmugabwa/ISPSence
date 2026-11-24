import { parseBindingInput, parseDiscoveryInput, validateBindingSelection } from '../../modules/billing/serviceBindings';
import { readPppoeInventory, type PppoeInventory } from '../../modules/billing/pppoeDiscovery';

const id = '11111111-1111-4111-8111-111111111111';
const input = { version: 1,discovery_id: id,server_id: '*1',profile_name: 'home',pool_name: 'subscribers',cpe_mac: null,reason: 'Initial setup',request_key: id };
const inventory: PppoeInventory = {
  ros_version: '6.49.18',servers: [{ id: '*1',service_name: 'Internet',interface: 'vlan20',default_profile: 'home',disabled: false,authentication: ['pap','chap'] }],
  profiles: [{ name: 'home',local_address: '10.0.0.1',remote_address: 'subscribers' }],pools: [{ name: 'subscribers',ranges: '10.0.0.2-10.0.0.254' }],radius_enabled: false,ppp_radius_clients: 0,local_username_collision: false,
};
test.each([{ version: 0 },{ version: '1' },{ discovery_id: 'bad' },{ server_id: '' },{ profile_name: 'a\n' },{ pool_name: 'a'.repeat(256) },{ device_id: 1 },{ active: true },{ cpe_mac: 'FF:FF:FF:FF:FF:FF' },{ cpe_mac: '00:00:00:00:00:00' },{ cpe_mac: '03:00:00:00:00:01' },{ reason: '' }])('refuses invalid or injected binding fields %j',(fields) => {
  expect(() => parseBindingInput({ ...input,...fields })).toThrow();
});
test('normalizes a CPE address and uses explicit router discovery',() => {
  expect(parseBindingInput({ ...input,cpe_mac: '02:ab:cd:00:00:01' }).cpe_mac).toBe('02:AB:CD:00:00:01');
  expect(parseDiscoveryInput({ device_id: 1,version: 2 })).toEqual({ device_id: 1,version: 2 });
  expect(() => parseDiscoveryInput({ device_id: '1',version: 2 })).toThrow();
  expect(() => parseDiscoveryInput({ device_id: 1,version: 2,ip: 'untrusted' })).toThrow();
});
test('uses capabilities rather than model and requires the existing server defaults',() => {
  expect(validateBindingSelection(inventory,input).interface).toBe('vlan20');
  expect(validateBindingSelection({ ...inventory,ros_version: '7.20' },input).service_name).toBe('Internet');
  for (const altered of [
    { ...inventory,local_username_collision: true },
    { ...inventory,servers: [{ ...inventory.servers[0],disabled: true }] },
    { ...inventory,servers: [{ ...inventory.servers[0],authentication: ['mschap2'] }] },
    { ...inventory,servers: [{ ...inventory.servers[0],default_profile: 'different' }] },
    { ...inventory,profiles: [{ ...inventory.profiles[0],remote_address: '10.0.0.2' }] },
    { ...inventory,profiles: [{ ...inventory.profiles[0],local_address: '' }] },
  ]) expect(() => validateBindingSelection(altered,input)).toThrow();
});
test('discovery reads only allowlisted properties, projects extra fields, and detects case variants',async () => {
  const read = jest.fn(async (path: string) => {
    const rows: Record<string,Record<string,string>[]> = {
      '/system/resource/print': [{ version: '7.20' }],
      '/interface/pppoe-server/server/print': [{ '.id': '*1','service-name': 'Internet',interface: 'vlan20','default-profile': 'home',disabled: 'false',authentication: 'pap,chap',password: 'never-return' }],
      '/ppp/profile/print': [{ name: 'home','local-address': '10.0.0.1','remote-address': 'subscribers','on-up': 'never-return' }],
      '/ip/pool/print': [{ name: 'subscribers',ranges: '10.0.0.2-10.0.0.254' }],
      '/ppp/aaa/print': [{ 'use-radius': 'yes' }],
      '/radius/print': [{ service: 'ppp,hotspot',disabled: 'no',secret: 'never-return' }],
      '/ppp/secret/print': [{ name: 'HOME-01',service: 'pppoe',password: 'never-return' }],
    };
    return rows[path];
  });
  const result = await readPppoeInventory(read,'home-01');
  expect(result.local_username_collision).toBe(true);
  expect(result.ppp_radius_clients).toBe(1);
  expect(result.radius_enabled).toBe(true);
  expect(JSON.stringify(result)).not.toContain('never-return');
  expect(read.mock.calls.every(([path]) => path.endsWith('/print'))).toBe(true);
  for (const call of read.mock.calls as unknown as [string,Record<string,string>][]) {
    expect(call[1]['.proplist']).not.toMatch(/password|secret|on-up|on-down/);
  }
});
test('an unreadable configuration fails discovery instead of implying an empty safe router',async () => {
  await expect(readPppoeInventory(async () => { throw new Error('permission denied'); },'home')).rejects.toThrow('permission denied');
});
