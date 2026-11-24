import { randomUUID } from 'crypto';
import { query, transaction } from '../../config/database';
import { AccessError, lockCustomer, textReason, validUuid } from './accessPolicy';
import { managementEvent } from './accessManagement';

export const serviceColumns = `id,customer_id,service_type,mode,username,label,state,version,created_at,
  (SELECT c.revision FROM billing_service_credentials c WHERE c.service_id=billing_customer_services.id) AS credential_revision,
  (SELECT c.updated_at FROM billing_service_credentials c WHERE c.service_id=billing_customer_services.id) AS credentials_updated_at,
  (SELECT count(*)::int FROM billing_service_periods sp JOIN billing_subscriptions bs ON bs.id=sp.subscription_id WHERE sp.service_id=billing_customer_services.id AND bs.status='pending_activation') AS prepared_periods,
  (SELECT jsonb_build_object('device_id',b.device_id,'router_name',d.name,'server_id',b.server_id,'service_name',b.service_name,
    'interface_name',b.interface_name,'profile_name',b.profile_name,'pool_name',b.pool_name,'cpe_mac',b.cpe_mac,'version',b.version,'status',b.status)
    FROM billing_service_bindings b JOIN devices d ON d.id=b.device_id WHERE b.service_id=billing_customer_services.id ORDER BY b.version DESC LIMIT 1) AS binding`;
const columns = serviceColumns;
export interface ServiceDraft { customer_id: number; username: string | null; label: string; reason: string; request_key: string }

export function parseServiceDraft(body: unknown): ServiceDraft {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400,'Customer service details are required');
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some((k) => !['customer_id','username','label','reason','request_key'].includes(k))) throw new AccessError(400,'Unsupported customer service field');
  if (typeof b.customer_id !== 'number' || !Number.isInteger(b.customer_id) || b.customer_id<1 || b.customer_id>2147483647) throw new AccessError(400,'A valid customer is required');
  if (!validUuid(b.request_key)) throw new AccessError(400,'A valid request key is required');
  if (typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length>100) throw new AccessError(400,'Enter a service label up to 100 characters');
  let username: string | null = null;
  if (b.username !== undefined) {
    if (typeof b.username !== 'string') throw new AccessError(400,'Enter a valid PPPoE username');
    username = b.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || /^(acct_|sim_)/.test(username)) throw new AccessError(400,'Use 3–64 letters, digits, dots, underscores or hyphens; acct_ and sim_ prefixes are reserved');
  }
  return { customer_id: b.customer_id,username,label: b.label.trim(),reason: textReason(b.reason),request_key: b.request_key };
}

export async function createServiceDraft(input: ServiceDraft, actor: string) {
  try {
    return await transaction(async (client) => {
      await lockCustomer(client,input.customer_id);
      const payload = { customer_id: input.customer_id,username: input.username,label: input.label,reason: input.reason };
      const previous = (await client.query(`SELECT ${columns},request_payload=$2::jsonb AS same_request FROM billing_customer_services WHERE request_key=$1`,[input.request_key,JSON.stringify(payload)])).rows[0];
      if (previous) {
        if (!previous.same_request) throw new AccessError(409,'This request key was already used for different service details');
        const { same_request: _same,...service } = previous; void _same;
        return { service,replayed: true };
      }
      const username = input.username ?? `ppp_${randomUUID().replace(/-/g,'')}`;
      const service = (await client.query(`INSERT INTO billing_customer_services(id,customer_id,service_type,mode,username,label,state,request_key,request_payload)
        VALUES($1,$2,'pppoe','live',$3,$4,'draft',$5,$6) RETURNING ${columns}`,
      [randomUUID(),input.customer_id,username,input.label,input.request_key,JSON.stringify(payload)])).rows[0];
      await managementEvent(client,input.customer_id,'pppoe_service_prepared',actor,input.reason,{ service_id: service.id });
      return { service,replayed: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AccessError(409,'This username or request key is already in use');
    throw error;
  }
}

export async function listCustomerServices(customerId: number) {
  return query(`SELECT ${columns} FROM billing_customer_services WHERE customer_id=$1 ORDER BY created_at DESC,id`,[customerId]);
}
