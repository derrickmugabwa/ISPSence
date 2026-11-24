import { randomUUID } from 'crypto';
import { query, transaction } from '../../config/database';
import type { DeviceRow } from '../../services/mikrotik/DeviceCollector';
import { AccessError, lockCustomer, textReason, validUuid } from './accessPolicy';
import { managementEvent } from './accessManagement';
import { serviceColumns } from './customerServices';
import type { PppoeInventory } from './pppoeDiscovery';

export interface BindingInput {
  version: number; discovery_id: string; server_id: string; profile_name: string; pool_name: string;
  cpe_mac: string | null; reason: string; request_key: string;
}
function object(body: unknown, keys: string[]): Record<string,unknown> {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new AccessError(400,'Router setup details are required');
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some((k) => !keys.includes(k))) throw new AccessError(400,'Unsupported router setup field');
  if (typeof b.version!=='number' || !Number.isInteger(b.version) || b.version<1 || b.version>=2147483647) throw new AccessError(400,'Refresh the connection before changing router setup');
  return b;
}
export function parseDiscoveryInput(body: unknown): { device_id: number; version: number } {
  const b = object(body,['device_id','version']);
  if (typeof b.device_id!=='number' || !Number.isInteger(b.device_id) || b.device_id<1 || b.device_id>2147483647) throw new AccessError(400,'Select a valid router');
  return { device_id: b.device_id,version: b.version as number };
}
export function parseBindingInput(body: unknown): BindingInput {
  const b = object(body,['version','discovery_id','server_id','profile_name','pool_name','cpe_mac','reason','request_key']);
  if (!validUuid(b.request_key) || !validUuid(b.discovery_id)) throw new AccessError(400,'A valid discovery and request key are required');
  if ([b.server_id,b.profile_name,b.pool_name].some((value) => typeof value!=='string' || !value.length || value.length>255 || Array.from(value).some((character) => character.charCodeAt(0)<32))) throw new AccessError(400,'Select a discovered server, profile and pool');
  const mac = b.cpe_mac===undefined || b.cpe_mac===null || b.cpe_mac==='' ? null : typeof b.cpe_mac==='string' ? b.cpe_mac.toUpperCase() : '';
  if (mac!==null && (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac) || (parseInt(mac.slice(0,2),16)&1)!==0 || mac==='00:00:00:00:00:00')) throw new AccessError(400,'Enter a unicast CPE MAC address, for example 02:00:00:00:00:01');
  return { version: b.version as number,discovery_id: b.discovery_id as string,server_id: b.server_id as string,profile_name: b.profile_name as string,pool_name: b.pool_name as string,cpe_mac: mac,reason: textReason(b.reason),request_key: b.request_key as string };
}
function draft(service: Record<string,unknown> | undefined) {
  if (!service) throw new AccessError(404,'Customer service not found');
  if (service.service_type!=='pppoe' || service.mode!=='live' || service.state!=='draft') throw new AccessError(409,'Router setup is available for prepared PPPoE connections only');
}
export async function bindingRouters() {
  return query('SELECT id,name,ros_version,status,ssh_only FROM devices WHERE device_type=\'router\' ORDER BY name,id');
}
export async function discoverServiceRouter(id: string,input: { device_id: number; version: number }) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid service ID');
  const service = (await query('SELECT customer_id,service_type,mode,state,username,version FROM billing_customer_services WHERE id=$1',[id]))[0];
  draft(service);
  if (service.version!==input.version) throw new AccessError(409,'This connection changed. Refresh before discovering router setup');
  const device = (await query<DeviceRow>('SELECT * FROM devices WHERE id=$1 AND device_type=\'router\'',[input.device_id]))[0];
  if (!device) throw new AccessError(404,'Router not found');
  if (device.ssh_only) throw new AccessError(409,'Enable the managed router API before discovering PPPoE setup');
  const { DeviceCollector } = await import('../../services/mikrotik/DeviceCollector');
  const collector = new DeviceCollector(device);
  let inventory: PppoeInventory;
  try { await collector.connect(); inventory = await collector.pppoeInventory(String(service.username)); }
  catch { throw new AccessError(502,'Could not read complete PPPoE configuration. Check router connectivity, identity trust and API read permissions, then retry'); }
  finally { collector.disconnect(); }
  // No transaction/row lock is held over router I/O. Fence a changed service
  // after discovery so an old read cannot approve a newer configuration.
  return transaction(async (client) => {
    await lockCustomer(client,Number(service.customer_id));
    const current = (await client.query('SELECT * FROM billing_customer_services WHERE id=$1 FOR UPDATE',[id])).rows[0];
    draft(current);
    if (current.version!==input.version) throw new AccessError(409,'This connection changed during discovery. Refresh and retry');
    return (await client.query(`INSERT INTO billing_pppoe_discoveries(id,service_id,device_id,service_version,inventory)
      VALUES($1,$2,$3,$4,$5) RETURNING id,device_id,service_version,inventory,created_at,expires_at`,[randomUUID(),id,input.device_id,input.version,JSON.stringify(inventory)])).rows[0];
  });
}
export function validateBindingSelection(inventory: PppoeInventory,input: BindingInput) {
  if (inventory.local_username_collision) throw new AccessError(409,'A local PPP secret uses this username. Resolve the cutover before assigning this router');
  const server = inventory.servers.find((s) => s.id===input.server_id && !s.disabled);
  const profile = inventory.profiles.find((p) => p.name===input.profile_name);
  const pool = inventory.pools.find((p) => p.name===input.pool_name);
  if (!server || !profile || !pool) throw new AccessError(409,'Select an enabled discovered server and its available profile and pool');
  if (!server.authentication.some((a) => a==='pap' || a==='chap')) throw new AccessError(409,'The server must offer PAP or CHAP for the initial PPPoE implementation');
  // V1 only binds the existing server defaults. Arbitrary profile/pool changes
  // need a separate provision-and-verify operation, never a silent router edit.
  if (server.default_profile!==profile.name || profile.remote_address!==pool.name || !profile.local_address) throw new AccessError(409,'Use the server’s existing default profile with a local address and a named IPv4 pool');
  return server;
}
export async function saveServiceBinding(id: string,input: BindingInput,actor: string) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid service ID');
  try {
    return await transaction(async (client) => {
      const found = (await client.query('SELECT customer_id FROM billing_customer_services WHERE id=$1',[id])).rows[0];
      if (!found) throw new AccessError(404,'Customer service not found');
      await lockCustomer(client,found.customer_id);
      const service = (await client.query(`SELECT ${serviceColumns} FROM billing_customer_services WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      draft(service);
      const { request_key: _key,...details } = input; void _key;
      const payload = JSON.stringify({ service_id: id,...details });
      const previous = (await client.query('SELECT service_id,request_payload=$2::jsonb AS same_request FROM billing_service_bindings WHERE request_key=$1',[input.request_key,payload])).rows[0];
      if (previous) {
        if (previous.service_id!==id || !previous.same_request) throw new AccessError(409,'This request key was already used for different router setup');
        return { service,replayed: true };
      }
      if (service.version!==input.version) throw new AccessError(409,'This connection changed. Refresh before saving router setup');
      const discovery = (await client.query(`SELECT *,expires_at>clock_timestamp() AS fresh FROM billing_pppoe_discoveries WHERE id=$1 AND service_id=$2`,[input.discovery_id,id])).rows[0];
      if (!discovery || !discovery.fresh || discovery.service_version!==input.version) throw new AccessError(409,'Router discovery is stale. Discover the router again');
      const server = validateBindingSelection(discovery.inventory,input);
      await client.query(`INSERT INTO billing_service_bindings(id,service_id,device_id,discovery_id,server_id,service_name,interface_name,profile_name,pool_name,cpe_mac,version,request_key,request_payload,actor,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[randomUUID(),id,discovery.device_id,input.discovery_id,input.server_id,server.service_name,server.interface,input.profile_name,input.pool_name,input.cpe_mac,input.version+1,input.request_key,payload,actor,input.reason]);
      await client.query('UPDATE billing_customer_services SET version=version+1 WHERE id=$1',[id]);
      await managementEvent(client,service.customer_id,'pppoe_router_binding_prepared',actor,input.reason,{ service_id: id,device_id: discovery.device_id,binding_version: input.version+1 });
      const updated = (await client.query(`SELECT ${serviceColumns} FROM billing_customer_services WHERE id=$1`,[id])).rows[0];
      return { service: updated,replayed: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code==='23505') throw new AccessError(409,'This router setup request was already used. Refresh the connection');
    throw error;
  }
}
