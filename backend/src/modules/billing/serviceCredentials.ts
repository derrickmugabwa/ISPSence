import { randomBytes } from 'crypto';
import { transaction } from '../../config/database';
import { encrypt } from '../../utils/crypto';
import { AccessError, lockCustomer, textReason, validUuid } from './accessPolicy';
import { managementEvent } from './accessManagement';
import { serviceColumns } from './customerServices';

export interface CredentialInput { version: number; reason: string; request_key: string }
export function parseCredentialInput(body: unknown): CredentialInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400,'Password request details are required');
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some((k) => !['version','reason','request_key'].includes(k))) throw new AccessError(400,'Unsupported password request field');
  if (typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version<1 || b.version>=2147483647) throw new AccessError(400,'Refresh the connection before generating a password');
  if (!validUuid(b.request_key)) throw new AccessError(400,'A valid request key is required');
  return { version: b.version,reason: textReason(b.reason),request_key: b.request_key };
}

export async function generateServiceCredentials(id: string, input: CredentialInput, actor: string) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid service ID');
  try {
    return await transaction(async (client) => {
      const found = (await client.query('SELECT customer_id FROM billing_customer_services WHERE id=$1',[id])).rows[0];
      if (!found) throw new AccessError(404,'Customer service not found');
      await lockCustomer(client,found.customer_id);
      const service = (await client.query(`SELECT ${serviceColumns} FROM billing_customer_services WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      if (service.service_type!=='pppoe' || service.mode!=='live' || service.state!=='draft') throw new AccessError(409,'Password generation is available for prepared PPPoE connections only');
      const payload = JSON.stringify({ service_id: id,version: input.version,reason: input.reason });
      const previous = (await client.query('SELECT service_id,request_payload=$2::jsonb AS same_request FROM billing_service_credential_requests WHERE request_key=$1',[input.request_key,payload])).rows[0];
      if (previous) {
        if (previous.service_id!==id || !previous.same_request) throw new AccessError(409,'This request key was already used for different password details');
        return { service,password: null,replayed: true };
      }
      if (service.version!==input.version) throw new AccessError(409,'This connection changed. Refresh before generating another password');
      const password = randomBytes(18).toString('base64url');
      const encrypted = encrypt(password);
      const revision = Number(service.credential_revision ?? 0)+1;
      await client.query(`INSERT INTO billing_service_credentials(service_id,password_encrypted,revision) VALUES($1,$2,$3)
        ON CONFLICT(service_id) DO UPDATE SET password_encrypted=EXCLUDED.password_encrypted,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,[id,encrypted,revision]);
      await client.query('UPDATE billing_customer_services SET version=version+1 WHERE id=$1',[id]);
      await client.query('INSERT INTO billing_service_credential_requests(request_key,service_id,request_payload,result_version) VALUES($1,$2,$3,$4)',[input.request_key,id,payload,service.version+1]);
      await managementEvent(client,service.customer_id,revision===1 ? 'pppoe_password_created' : 'pppoe_password_reset',actor,input.reason,{ service_id: id,credential_revision: revision });
      const updated = (await client.query(`SELECT ${serviceColumns} FROM billing_customer_services WHERE id=$1`,[id])).rows[0];
      return { service: updated,password,replayed: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code==='23505') throw new AccessError(409,'This password request key is already in use');
    throw error;
  }
}
