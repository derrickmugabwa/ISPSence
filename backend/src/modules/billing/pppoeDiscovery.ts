import { AccessError } from './accessPolicy';

type Row = Record<string,string>;
export type RouterReader = (path: string, params: Record<string,string>) => Promise<Row[]>;
export interface PppoeInventory {
  ros_version: string;
  servers: { id: string; service_name: string; interface: string; default_profile: string; disabled: boolean; authentication: string[] }[];
  profiles: { name: string; local_address: string; remote_address: string }[];
  pools: { name: string; ranges: string }[];
  radius_enabled: boolean;
  ppp_radius_clients: number;
  local_username_collision: boolean;
}
const yes = (v?: string) => v==='true' || v==='yes';
// .proplist prevents scripts, passwords and RADIUS secrets from being fetched.
// Projection below also distrusts extra fields returned by a device.
export async function readPppoeInventory(read: RouterReader, username: string): Promise<PppoeInventory> {
  const resource = await read('/system/resource/print',{ '.proplist': 'version' });
  const servers = await read('/interface/pppoe-server/server/print',{ '.proplist': '.id,service-name,interface,default-profile,disabled,authentication' });
  const profiles = await read('/ppp/profile/print',{ '.proplist': 'name,local-address,remote-address' });
  const pools = await read('/ip/pool/print',{ '.proplist': 'name,ranges' });
  const aaa = await read('/ppp/aaa/print',{ '.proplist': 'use-radius' });
  const radius = await read('/radius/print',{ '.proplist': 'service,disabled' });
  // Disabled local secrets can still complicate cutover. Report any matching
  // PPP/any entry, including case variants, without fetching their passwords.
  const secrets = await read('/ppp/secret/print',{ '.proplist': 'name,service' });
  if ([servers,profiles,pools,secrets,radius].some((rows) => rows.length>10000)) throw new AccessError(409,'Router inventory is too large for this setup flow');
  return {
    ros_version: resource[0]?.version ?? '',
    servers: servers.map((s) => ({ id: s['.id'],service_name: s['service-name'] ?? '',interface: s.interface ?? '',default_profile: s['default-profile'] ?? '',disabled: yes(s.disabled),authentication: (s.authentication ?? '').split(',').filter(Boolean) })),
    profiles: profiles.map((p) => ({ name: p.name,local_address: p['local-address'] ?? '',remote_address: p['remote-address'] ?? '' })),
    pools: pools.map((p) => ({ name: p.name,ranges: p.ranges ?? '' })),
    radius_enabled: yes(aaa[0]?.['use-radius']),
    ppp_radius_clients: radius.filter((r) => !yes(r.disabled) && (r.service ?? '').split(',').includes('ppp')).length,
    local_username_collision: secrets.some((s) => s.name?.toLowerCase()===username.toLowerCase() && (!s.service || ['any','pppoe'].includes(s.service))),
  };
}
