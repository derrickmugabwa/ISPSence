import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import type { Pool, PoolClient } from 'pg';
import { AccessError, lockCustomer, macAddress, scheduleAllows, validUuid, type AccessSchedule } from './accessPolicy';
import { decrypt } from '../../utils/crypto';
import { SIMULATION_TIMES } from './accessTime';
import { PPPOE_LAB_SCHEMA } from './pppoeLabSchema';
import type { PppoeApplyResult, PppoeProvisioningClaim, PppoeProvisioningEvidence } from './pppoeProvisioning';

type Attributes = Record<string,unknown>;
function attr(body: Attributes,key: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- Fixed parser names only.
  const entry = body[key] as { value?: unknown } | undefined;
  if (entry===undefined) return undefined;
  if (!entry || typeof entry!=='object' || !Array.isArray(entry.value) || entry.value.length!==1) throw new AccessError(400,'Invalid lab RADIUS attribute');
  return entry.value[0];
}
function string(body: Attributes,key: string,max=128): string {
  const value=attr(body,key);
  if (typeof value!=='string' || !value || value.length>max || Array.from(value).some(c=>c.charCodeAt(0)<32)) throw new AccessError(400,'Invalid lab RADIUS text');
  return value;
}
function hex(value: unknown,min: number,max=min): Buffer {
  if (typeof value!=='string') throw new AccessError(400,'Invalid RADIUS octets');
  const raw=value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[a-f0-9]+$/i.test(raw) || raw.length%2 || raw.length<min*2 || raw.length>max*2) throw new AccessError(400,'Invalid RADIUS octets');
  return Buffer.from(raw,'hex');
}
function object(body: unknown): Attributes {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new AccessError(400,'Lab RADIUS attributes required');
  return body as Attributes;
}
function credentialOctets(body: Attributes,key: string,min: number,max=min): Buffer {
  const value=attr(body,key);
  // FreeRADIUS 3.2 REST encodes octets as JSON byte characters, not hex.
  // Require the typed representation so text/hex fixtures remain unambiguous.
  // eslint-disable-next-line security/detect-object-injection -- Fixed credential attribute names only.
  const entry=body[key] as { type?: unknown } | undefined;
  if (entry?.type!=='octets') return hex(value,min,max);
  if (typeof value!=='string' || value.length<min || value.length>max || Array.from(value).some(c=>c.charCodeAt(0)>255)) throw new AccessError(400,'Invalid RADIUS octets');
  return Buffer.from(value,'latin1');
}
export function verifyPppoePassword(body: Attributes,password: string,vector: Buffer): boolean {
  const pap=attr(body,'User-Password'),chap=attr(body,'CHAP-Password');
  if ((pap===undefined)===(chap===undefined)) return false;
  if (pap!==undefined) {
    if (typeof pap!=='string' || pap.length>256) return false;
    return timingSafeEqual(createHash('sha256').update(pap).digest(),createHash('sha256').update(password).digest());
  }
  const response=credentialOctets(body,'CHAP-Password',17),challenge=attr(body,'CHAP-Challenge');
  // MD5 is required by the CHAP wire protocol, never used for stored passwords.
  const expected=createHash('md5').update(response.subarray(0,1)).update(password).update(challenge===undefined ? vector : credentialOctets(body,'CHAP-Challenge',1,253)).digest();
  return timingSafeEqual(response.subarray(1),expected);
}
function context(body: Attributes) {
  const source=string(body,'Tmp-IP-Address-0',45);
  if (source!=='127.0.0.1') throw new AccessError(403,'Unenrolled lab transport');
  return { source,nas: string(body,'NAS-Identifier',100),username: string(body,'User-Name',64),mac: macAddress(string(body,'Calling-Station-Id',17)) };
}
function number(body: Attributes,key: string): number {
  const raw=attr(body,key) ?? 0;
  if (!/^\d{1,10}$/.test(String(raw)) || Number(raw)>4294967295) throw new AccessError(400,'Invalid accounting counter');
  return Number(raw);
}
function bytes(body: Attributes,direction: 'Input' | 'Output') {
  const result=number(body,`Acct-${direction}-Gigawords`)*4294967296+number(body,`Acct-${direction}-Octets`);
  if (!Number.isSafeInteger(result)) throw new AccessError(400,'Accounting counter exceeds exact range');
  return result;
}
const digest=(value: unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deny=(reason='policy')=>new AccessError(403,`PPPoE lab admission denied: ${reason}`);

/** No production route imports this class. Every transaction verifies the
 * dedicated search_path. Lab clocks/readiness proofs are not live NAS evidence. */
export class PppoeLab {
  private constructor(private pool: Pool,private schema: string,private clock: ()=>Date) {}
  static async create(pool: Pool,schema: string,clock=()=>new Date()) {
    if (!/^pppoe_auth_lab_[a-f0-9]{32}$/.test(schema)) throw new AccessError(403,'A disposable PPPoE authentication schema is required');
    const lab=new PppoeLab(pool,schema,clock);
    await lab.tx(client=>client.query(PPPOE_LAB_SCHEMA));
    return lab;
  }
  private async tx<T>(work: (client: PoolClient)=>Promise<T>): Promise<T> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope=(await client.query('SELECT current_schema() AS name,current_schemas(false)::text[] AS path')).rows[0];
      if (scope.name!==this.schema || scope.path.length!==1 || scope.path[0]!==this.schema) throw new AccessError(403,'Refusing a production or mixed search_path');
      const result=await work(client); await client.query('COMMIT'); return result;
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async authenticate(raw: unknown) {
    const body=object(raw),ctx=context(body),vector=hex(attr(body,'Tmp-String-0') ?? attr(body,'Tmp-Octets-0'),16);
    if (attr(body,'Service-Type')!=='Framed-User' || attr(body,'Framed-Protocol')!=='PPP') throw deny('framing');
    const called=string(body,'Called-Station-Id',255);
    return this.tx(async client=>{
      const owner=(await client.query('SELECT customer_id,id FROM billing_customer_services WHERE username=$1',[ctx.username])).rows[0];
      if (!owner) throw deny('unknown login');
      await lockCustomer(client,owner.customer_id);
      const service=(await client.query(`SELECT s.*,c.password_encrypted,c.revision AS credential_revision FROM billing_customer_services s
        JOIN billing_service_credentials c ON c.service_id=s.id WHERE s.id=$1 FOR UPDATE OF s`,[owner.id])).rows[0];
      if (!service || service.service_type!=='pppoe' || service.mode!=='live' || service.state!=='draft' || !verifyPppoePassword(body,decrypt(service.password_encrypted),vector)) throw deny('service credentials');
      const binding=(await client.query('SELECT * FROM billing_service_bindings WHERE service_id=$1 ORDER BY version DESC LIMIT 1',[service.id])).rows[0];
      const enrollment=(await client.query('SELECT * FROM pppoe_lab_enrollments WHERE service_id=$1',[service.id])).rows[0];
      if (!binding || !enrollment?.ready || enrollment.binding_version!==binding.version || enrollment.nas!==ctx.nas || enrollment.source_ip!==ctx.source || binding.service_name!==called || (binding.cpe_mac && binding.cpe_mac.toLowerCase()!==ctx.mac)) throw deny('NAS binding');
      const now=this.clock();
      const policy=(await client.query(`SELECT pol.*,coalesce(ctl.desired_state,'enabled') AS desired_state,ctl.version AS control_version,n.version AS network_version,n.download_bps,n.upload_bps
        FROM (SELECT $1::int AS customer_id) own LEFT JOIN billing_access_policy pol USING(customer_id)
        LEFT JOIN billing_customer_controls ctl USING(customer_id) LEFT JOIN billing_customer_network n USING(customer_id)`,[owner.customer_id])).rows[0];
      if (policy.desired_state!=='enabled' || !scheduleAllows(policy.schedule,now)) throw deny('customer controls or schedule');
      const device=(await client.query('SELECT enabled FROM billing_customer_devices WHERE customer_id=$1 AND mac=$2::macaddr',[owner.customer_id,ctx.mac])).rows[0];
      if (device?.enabled===false || (policy.registered_only && !device?.enabled)) throw deny('device policy');
      const periods=(await client.query(`SELECT s.*,sp.queue_sequence,coalesce(p.package_snapshot,g.package_snapshot) AS terms,p.payment_status,
        r.revoked_at,r.frozen_remaining_ms,l.activation_at AS effective_at,l.expires_at AS effective_expiry,
        EXISTS(SELECT 1 FROM billing_payment_receipts receipt WHERE receipt.purchase_id=p.id AND receipt.amount_minor=p.amount_minor) AS has_receipt
        FROM billing_service_periods sp JOIN billing_subscriptions s ON s.id=sp.subscription_id
        LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
        LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id LEFT JOIN pppoe_lab_periods l ON l.subscription_id=s.id
        WHERE sp.service_id=$1 ORDER BY sp.queue_sequence FOR UPDATE OF s`,[service.id])).rows;
      const period=periods.find(p=>p.effective_expiry===null || p.effective_expiry===undefined || new Date(p.effective_expiry)>now);
      if (!period || period.mode!=='live' || period.status!=='pending_activation' || period.revoked_at || period.frozen_remaining_ms!==null && period.frozen_remaining_ms!==undefined || period.purchase_id && (period.payment_status!=='paid' || !period.has_receipt)) throw deny('funded entitlement');
      const terms=period.terms;
      if (terms.service_type!=='pppoe' || terms.service_id!==service.id || !Number.isInteger(terms.duration_value) || terms.duration_value<1 || terms.duration_value>10000 || !['hour','day','week','calendar_month'].includes(terms.duration_unit)) throw deny('frozen package terms');
      const rates={ up: Number(policy.upload_bps ?? terms.upload_bps),down: Number(policy.download_bps ?? terms.download_bps) };
      if (![rates.up,rates.down].every(v=>Number.isSafeInteger(v) && v>0 && v<=1e12)) throw deny();
      const usage=(await client.query('SELECT coalesce(sum(upload_bytes+download_bytes),0) AS n FROM pppoe_lab_admissions WHERE subscription_id=$1',[period.id])).rows[0];
      if (terms.allowance_bytes!==null && terms.allowance_bytes!==undefined && Number(usage.n)>=Number(terms.allowance_bytes)) throw deny();
      let timeout=Math.min(30,period.effective_expiry ? Math.floor((new Date(period.effective_expiry).getTime()-now.getTime())/1000)-5 : 30);
      for (let s=1;s<=35;s++) if (!scheduleAllows(policy.schedule as AccessSchedule, new Date(now.getTime()+s*1000))) { timeout=Math.min(timeout,s-5); break; }
      if (timeout<1) throw deny('admission boundary');
      const policyDigest=digest({ service_version: service.version,credential: service.credential_revision,binding: binding.version,policy: policy.version ?? 0,control: policy.control_version ?? 0,network: policy.network_version ?? 0,period: period.id,...ctx });
      const requestKey=digest({ source: ctx.source,nas: ctx.nas,vector: vector.toString('hex') });
      const previous=(await client.query('SELECT * FROM pppoe_lab_admissions WHERE request_key=$1',[requestKey])).rows[0];
      const reply=(id: string,seconds: number)=>({ 'reply:Class': `lab:${id}`,'reply:Service-Type': 'Framed-User','reply:Framed-Protocol': 'PPP','reply:Framed-Pool': binding.pool_name,'reply:Mikrotik-Group': binding.profile_name,'reply:Mikrotik-Rate-Limit': `${rates.up}/${rates.down}`,'reply:Session-Timeout': seconds,'reply:Acct-Interim-Interval': 10 });
      if (previous) {
        const remaining=Math.min(timeout,Math.floor((new Date(previous.admission_deadline).getTime()-now.getTime())/1000)-5);
        if (previous.policy_digest!==policyDigest || previous.state!=='reserved' || remaining<1) throw deny('request replay');
        return reply(previous.id,remaining);
      }
      // Never assume a missing Start means the NAS never enabled access.
      if ((await client.query(`SELECT id FROM pppoe_lab_admissions WHERE subscription_id=$1 AND (
        state='uncertain' OR (state='reserved' AND lease_until<=$2) OR ($3::boolean AND state<>'never_enabled')) LIMIT 1`,[period.id,now,!period.effective_at])).rows.length) throw deny('unresolved admission');
      const capacity=(await client.query(`SELECT count(*)::int AS n FROM pppoe_lab_admissions WHERE customer_id=$1 AND state IN ('reserved','started','uncertain')`,[owner.customer_id])).rows[0].n;
      if (capacity>=(policy.max_sessions ?? 1)) throw deny('connection limit');
      await client.query('INSERT INTO pppoe_lab_periods(subscription_id,service_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[period.id,service.id]);
      const id=randomUUID();
      await client.query(`INSERT INTO pppoe_lab_admissions(id,request_key,policy_digest,customer_id,service_id,subscription_id,nas,source_ip,cpe_mac,state,proposed_at,admission_deadline,lease_until,service_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11,$12,$13)`,[id,requestKey,policyDigest,owner.customer_id,service.id,period.id,ctx.nas,ctx.source,ctx.mac,now,new Date(now.getTime()+(timeout+5)*1000),new Date(now.getTime()+60000),service.version]);
      return reply(id,timeout);
    });
  }
  async accounting(raw: unknown) {
    const body=object(raw),ctx=context(body),kind=string(body,'Acct-Status-Type',32),session=string(body,'Acct-Session-Id');
    if (!['Start','Interim-Update','Stop'].includes(kind)) throw new AccessError(400,'Unsupported correlated accounting');
    const rawClass=string(body,'Class',128),classValue=rawClass.startsWith('0x') ? hex(rawClass,1,128).toString('utf8') : rawClass;
    if (!classValue.startsWith('lab:') || !validUuid(classValue.slice(4))) throw deny();
    const id=classValue.slice(4),elapsed=number(body,'Acct-Session-Time'),upload=bytes(body,'Input'),download=bytes(body,'Output');
    const ip=attr(body,'Framed-IP-Address');
    if (ip!==undefined && (typeof ip!=='string' || isIP(ip)!==4)) throw new AccessError(400,'Invalid framed IPv4 address');
    const fingerprint=digest({ id,kind,session,elapsed,upload,download,...ctx });
    return this.tx(async client=>{
      const admission=await this.lockAdmission(client,id,ctx);
      if ((await client.query('SELECT fingerprint FROM pppoe_lab_packets WHERE fingerprint=$1',[fingerprint])).rows.length) return { replayed: true };
      const now=this.clock();
      if (admission.state==='never_enabled' || admission.session_key && admission.session_key!==session) throw deny();
      if (admission.state==='stopped') {
        // Late packets cannot revive sessions or change already-attributed usage.
        await client.query('INSERT INTO pppoe_lab_packets VALUES($1,$2,$3,$4)',[fingerprint,id,kind,now]);
        return { replayed: false,ignored: true };
      }
      if (!admission.started_at && (kind!=='Start' || elapsed!==0 || now>new Date(admission.admission_deadline))) throw deny();
      let startedAt=admission.started_at;
      if (!startedAt) {
        const event=attr(body,'Event-Timestamp');
        const milliseconds=typeof event==='number' || typeof event==='string' && /^\d{1,10}$/.test(event) ? Number(event)*1000 : typeof event==='string' && event.length<=100 ? Date.parse(event) : NaN;
        if (!Number.isFinite(milliseconds) || milliseconds<new Date(admission.proposed_at).getTime()-2000 || milliseconds>now.getTime()+2000) throw deny();
        // Preserve the earliest signed Start evidence, including delayed delivery.
        // The fixture models a <=2s NAS clock bound; production must qualify it.
        startedAt=new Date(Math.max(milliseconds,new Date(admission.proposed_at).getTime()));
      }
      if (ip && admission.client_ip && ip!==admission.client_ip) throw deny();
      await client.query(`UPDATE pppoe_lab_admissions SET state=$2,session_key=coalesce(session_key,$3),started_at=coalesce(started_at,$4),
        stopped_at=CASE WHEN $2='stopped' THEN $7 ELSE stopped_at END,last_seen_at=$7,upload_bytes=greatest(upload_bytes,$5),download_bytes=greatest(download_bytes,$6),
        elapsed_seconds=greatest(elapsed_seconds,$8),client_ip=coalesce(client_ip,$9::inet) WHERE id=$1`,[id,kind==='Stop' ? 'stopped' : 'started',session,startedAt,upload,download,now,elapsed,ip ?? null]);
      await client.query('INSERT INTO pppoe_lab_packets VALUES($1,$2,$3,$4)',[fingerprint,id,kind,now]);
      return { replayed: false };
    });
  }
  private async lockAdmission(client: PoolClient,id: string,ctx?: ReturnType<typeof context>) {
    const found=(await client.query('SELECT * FROM pppoe_lab_admissions WHERE id=$1',[id])).rows[0];
    if (!found) throw deny();
    await lockCustomer(client,found.customer_id);
    await client.query('SELECT id FROM billing_customer_services WHERE id=$1 FOR UPDATE',[found.service_id]);
    await client.query('SELECT id FROM billing_subscriptions WHERE id=$1 FOR UPDATE',[found.subscription_id]);
    const row=(await client.query('SELECT a.*,s.username FROM pppoe_lab_admissions a JOIN billing_customer_services s ON s.id=a.service_id WHERE a.id=$1 FOR UPDATE OF a',[id])).rows[0];
    if (ctx && (row.nas!==ctx.nas || row.source_ip!==ctx.source || row.username!==ctx.username || row.cpe_mac!==ctx.mac)) throw deny();
    return row;
  }
  /** Test driver only: explicit fictitious forwarding proof, separately from accounting. */
  async confirmReady(id: string,session: string,bindingVersion: number,usableAt: Date) {
    return this.tx(async client=>{
      const row=await this.lockAdmission(client,id);
      if ((await client.query('SELECT id FROM pppoe_lab_operations WHERE admission_id=$1',[id])).rows.length) throw deny('readiness owned by provisioning operation');
      return this.confirmReadyInTransaction(client,row,session,bindingVersion,usableAt);
    });
  }
  private async confirmReadyInTransaction(client: PoolClient,row: Record<string,any>,session: string,bindingVersion: number,usableAt: Date) { // eslint-disable-line @typescript-eslint/no-explicit-any -- Existing pg row fields.
      if (row.state==='never_enabled') throw deny();
      const enrollment=(await client.query('SELECT * FROM pppoe_lab_enrollments WHERE service_id=$1',[row.service_id])).rows[0];
      const current=(await client.query('SELECT version FROM billing_service_bindings WHERE service_id=$1 ORDER BY version DESC LIMIT 1',[row.service_id])).rows[0];
      const service=(await client.query('SELECT version FROM billing_customer_services WHERE id=$1',[row.service_id])).rows[0];
      if (!row.started_at || row.session_key!==session || !enrollment?.ready || enrollment.binding_version!==bindingVersion || current?.version!==bindingVersion || service.version!==row.service_version) throw deny();
      if (!(usableAt instanceof Date) || !Number.isFinite(usableAt.getTime()) || usableAt<new Date(row.started_at) || usableAt>this.clock() || usableAt>new Date(row.admission_deadline) || row.stopped_at && usableAt>new Date(row.stopped_at)) throw deny();
      const existing=(await client.query('SELECT * FROM pppoe_lab_periods WHERE subscription_id=$1 FOR UPDATE',[row.subscription_id])).rows[0];
      if (existing.activation_at) return existing;
      const sub=(await client.query(`SELECT coalesce(p.package_snapshot,g.package_snapshot) AS terms FROM billing_subscriptions s
        LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id WHERE s.id=$1`,[row.subscription_id])).rows[0];
      const terms=sub.terms;
      const times=(await client.query(SIMULATION_TIMES.replace('clock_timestamp()','$4::timestamptz'),[terms.duration_unit,terms.duration_value,terms.timezone ?? 'UTC',usableAt])).rows[0];
      return (await client.query('UPDATE pppoe_lab_periods SET activation_at=$2,expires_at=$3,confirmed_at=$4 WHERE subscription_id=$1 RETURNING *',[row.subscription_id,times.activation_at,times.expires_at,this.clock()])).rows[0];
  }
  /** Queue a first-session operation. The request never sends a router command. */
  async requestProvisioning(admissionId: string,requestKey: string) {
    if (!validUuid(admissionId) || !validUuid(requestKey)) throw new AccessError(400,'Valid operation identifiers required');
    return this.tx(async client=>{
      const row=await this.lockAdmission(client,admissionId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[requestKey]);
      const existing=(await client.query('SELECT * FROM pppoe_lab_operations WHERE request_key=$1 OR admission_id=$2',[requestKey,admissionId])).rows;
      if (existing.length) {
        if (existing.length!==1 || existing[0].request_key!==requestKey || existing[0].admission_id!==admissionId) throw new AccessError(409,'Provisioning request conflicts with an existing operation');
        return existing[0];
      }
      if (row.state!=='started' || !row.session_key || this.clock()>=new Date(row.admission_deadline)) throw deny('no provisional session');
      if ((await client.query("SELECT id FROM pppoe_lab_operations WHERE service_id=$1 AND state NOT IN ('confirmed','never_enabled')",[row.service_id])).rows.length) throw new AccessError(409,'A connection transition is already unresolved');
      const binding=(await client.query('SELECT * FROM pppoe_lab_enrollments WHERE service_id=$1',[row.service_id])).rows[0];
      if (!binding?.ready || !await this.provisioningPolicyMatches(client,row)) throw deny('stale provisioning policy');
      const now=this.clock(),id=randomUUID();
      const operation=(await client.query(`INSERT INTO pppoe_lab_operations(id,request_key,service_id,admission_id,binding_version,state,next_attempt_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'queued',$6,$6,$6) RETURNING *`,[id,requestKey,row.service_id,admissionId,binding.binding_version,now])).rows[0];
      await this.operationEvent(client,operation);
      return operation;
    });
  }
  private async provisioningPolicyMatches(client: PoolClient,row: Record<string,any>) { // eslint-disable-line @typescript-eslint/no-explicit-any -- Existing pg row fields.
    const service=(await client.query(`SELECT s.*,c.revision AS credential_revision FROM billing_customer_services s
      JOIN billing_service_credentials c ON c.service_id=s.id WHERE s.id=$1`,[row.service_id])).rows[0];
    const binding=(await client.query('SELECT * FROM billing_service_bindings WHERE service_id=$1 ORDER BY version DESC LIMIT 1',[row.service_id])).rows[0];
    const enrollment=(await client.query('SELECT * FROM pppoe_lab_enrollments WHERE service_id=$1',[row.service_id])).rows[0];
    const policy=(await client.query(`SELECT pol.version,pol.schedule,pol.registered_only,coalesce(ctl.desired_state,'enabled') AS desired_state,
      ctl.version AS control_version,n.version AS network_version FROM (SELECT $1::int AS customer_id) own
      LEFT JOIN billing_access_policy pol USING(customer_id) LEFT JOIN billing_customer_controls ctl USING(customer_id)
      LEFT JOIN billing_customer_network n USING(customer_id)`,[row.customer_id])).rows[0];
    const device=(await client.query('SELECT enabled FROM billing_customer_devices WHERE customer_id=$1 AND mac=$2::macaddr',[row.customer_id,row.cpe_mac])).rows[0];
    const sub=(await client.query(`SELECT s.status,s.mode,p.payment_status,p.id AS purchase_id,r.revoked_at,r.frozen_remaining_ms,l.expires_at,
      coalesce(p.package_snapshot,g.package_snapshot) AS terms,
      EXISTS(SELECT 1 FROM billing_payment_receipts receipt WHERE receipt.purchase_id=p.id AND receipt.amount_minor=p.amount_minor) AS has_receipt
      FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id
      LEFT JOIN billing_access_grants g ON g.id=s.grant_id
      LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id LEFT JOIN pppoe_lab_periods l ON l.subscription_id=s.id WHERE s.id=$1`,[row.subscription_id])).rows[0];
    const usage=(await client.query('SELECT coalesce(sum(upload_bytes+download_bytes),0) AS n FROM pppoe_lab_admissions WHERE subscription_id=$1',[row.subscription_id])).rows[0];
    if (!service || service.service_type!=='pppoe' || service.state!=='draft' || service.mode!=='live' || !binding || !enrollment?.ready || enrollment.binding_version!==binding.version
      || enrollment.nas!==row.nas || enrollment.source_ip!==row.source_ip || policy.desired_state!=='enabled' || !scheduleAllows(policy.schedule,this.clock())
      || device?.enabled===false || policy.registered_only && !device?.enabled
      || !sub || sub.status!=='pending_activation' || sub.mode!=='live' || sub.revoked_at || sub.frozen_remaining_ms!==null && sub.frozen_remaining_ms!==undefined
      || sub.purchase_id && (sub.payment_status!=='paid' || !sub.has_receipt) || sub.expires_at && this.clock()>=new Date(sub.expires_at)
      || sub.terms?.allowance_bytes!==null && sub.terms?.allowance_bytes!==undefined && Number(usage.n)>=Number(sub.terms.allowance_bytes)) return false;
    return row.policy_digest===digest({service_version:service.version,credential:service.credential_revision,binding:binding.version,
      policy:policy.version ?? 0,control:policy.control_version ?? 0,network:policy.network_version ?? 0,period:row.subscription_id,
      source:row.source_ip,nas:row.nas,username:service.username,mac:row.cpe_mac});
  }
  private async operationEvent(client: PoolClient,operation: Record<string,unknown>) {
    await client.query(`INSERT INTO pppoe_lab_operation_events(operation_id,state,code,generation,attempts,occurred_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [operation.id,operation.state,operation.result_code,operation.generation,operation.attempts,this.clock()]);
  }
  private async lockOperation(client: PoolClient,id: string) {
    if (!validUuid(id)) throw new AccessError(400,'Valid operation identifier required');
    const found=(await client.query('SELECT admission_id FROM pppoe_lab_operations WHERE id=$1',[id])).rows[0];
    if (!found) throw new AccessError(404,'Provisioning operation not found');
    const admission=await this.lockAdmission(client,found.admission_id);
    const operation=(await client.query('SELECT * FROM pppoe_lab_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    return {admission,operation};
  }
  async claimProvisioning(id: string): Promise<PppoeProvisioningClaim | null> {
    return this.tx(async client=>{
      const {admission:row,operation:op}=await this.lockOperation(client,id),now=this.clock();
      if (['confirmed','never_enabled','attention'].includes(op.state) || op.lease_until && now<new Date(op.lease_until) || now<new Date(op.next_attempt_at)) return null;
      const action=['queued','retry'].includes(op.state) ? 'apply' : 'probe';
      if (action==='apply' && (row.state!=='started' || now>=new Date(row.admission_deadline) || !await this.provisioningPolicyMatches(client,row))) {
        const changed=(await client.query("UPDATE pppoe_lab_operations SET state='attention',result_code='policy_or_deadline_changed',updated_at=$2 WHERE id=$1 RETURNING *",[id,now])).rows[0];
        await this.operationEvent(client,changed);return null;
      }
      let generation=op.generation;
      if (action==='apply') generation=(await client.query(`INSERT INTO pppoe_lab_fences(service_id,generation) VALUES($1,1)
        ON CONFLICT(service_id) DO UPDATE SET generation=pppoe_lab_fences.generation+1 RETURNING generation`,[row.service_id])).rows[0].generation;
      const token=randomUUID();
      const changed=(await client.query(`UPDATE pppoe_lab_operations SET state=$2,generation=$3,attempts=attempts+$4,
        lease_token=$5,lease_until=$6,updated_at=$7,result_code=$8 WHERE id=$1 RETURNING *`,
        [id,action==='apply' ? 'applying' : 'verifying',generation,action==='apply' ? 1 : 0,token,new Date(now.getTime()+10000),now,action==='apply' ? 'apply_claimed' : 'probe_claimed'])).rows[0];
      await this.operationEvent(client,changed);
      return {token,action,command:{operationId:id,admissionId:row.id,serviceId:row.service_id,subscriptionId:row.subscription_id,
        sessionKey:row.session_key,bindingVersion:op.binding_version,generation,provisionalEndsBy:new Date(row.admission_deadline)}};
    });
  }
  async pendingProvisioning(limit=25): Promise<string[]> {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new AccessError(400,'Choose a batch size from 1 to 100');
    return this.tx(async client=>(await client.query(`SELECT id FROM pppoe_lab_operations
      WHERE state NOT IN ('confirmed','never_enabled','attention') AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY next_attempt_at,id LIMIT $2`,[this.clock(),limit])).rows.map(r=>r.id));
  }
  private currentClaim(op: Record<string,any>,claim: PppoeProvisioningClaim) { // eslint-disable-line @typescript-eslint/no-explicit-any -- Existing pg row fields.
    if (!['applying','verifying'].includes(op.state) || op.lease_token!==claim.token || op.generation!==claim.command.generation
      || this.clock()>=new Date(op.lease_until) || (op.state==='applying')!==(claim.action==='apply')) throw new AccessError(409,'Provisioning worker lease is stale');
  }
  async recordProvisioningApply(claim: PppoeProvisioningClaim,result: PppoeApplyResult) {
    if (!['accepted','not_applied','unknown'].includes(result) || claim.action!=='apply') throw new AccessError(400,'Invalid provisioning apply result');
    await this.tx(async client=>{
      const {operation:op}=await this.lockOperation(client,claim.command.operationId);this.currentClaim(op,claim);
      // not_applied is a strict adapter guarantee: no side effects and no late
      // execution is possible. Otherwise the result must remain unknown.
      const state=result==='accepted' ? 'verifying' : result==='unknown' ? 'uncertain' : op.attempts>=3 ? 'attention' : 'retry';
      const code=result==='accepted' ? 'awaiting_readiness' : result==='unknown' ? 'apply_outcome_unknown' : 'definitely_not_applied';
      const delay=state==='retry' ? 2**op.attempts*1000 : state==='uncertain' ? 1000 : 0;
      const changed=(await client.query(`UPDATE pppoe_lab_operations SET state=$2,result_code=$3,lease_token=NULL,lease_until=NULL,
        next_attempt_at=$4,updated_at=$5 WHERE id=$1 RETURNING *`,[op.id,state,code,new Date(this.clock().getTime()+delay),this.clock()])).rows[0];
      await this.operationEvent(client,changed);
    });
  }
  async recordProvisioningProbe(claim: PppoeProvisioningClaim,evidence: PppoeProvisioningEvidence | null) {
    if (claim.action!=='probe') throw new AccessError(400,'A probe claim is required');
    await this.tx(async client=>{
      const {admission:row,operation:op}=await this.lockOperation(client,claim.command.operationId);this.currentClaim(op,claim);
      const now=this.clock();let state='uncertain',code='readiness_unknown';
      const matches=evidence && evidence.operationId===op.id && evidence.admissionId===row.id && evidence.serviceId===row.service_id
        && evidence.sessionKey===row.session_key && evidence.bindingVersion===op.binding_version && evidence.generation===op.generation
        && evidence.observedAt instanceof Date && Number.isFinite(evidence.observedAt.getTime()) && evidence.observedAt<=now
        && evidence.observedAt>=new Date(op.updated_at);
      if (evidence && !matches) code='mismatched_evidence';
      if (matches && evidence.state==='ready') {
        if (!(evidence.sessionEndsBy instanceof Date) || !Number.isFinite(evidence.sessionEndsBy.getTime())
          || evidence.sessionEndsBy>new Date(row.admission_deadline) || !(evidence.usableAt instanceof Date)
          || !Number.isFinite(evidence.usableAt.getTime()) || evidence.sessionEndsBy<=evidence.usableAt || evidence.usableAt>evidence.observedAt) code='invalid_enforcement_evidence';
        else {
          // The paid clock and durable confirmation commit together. A crash
          // before commit leaves both pending and recovery probes the same op.
          try {
            await this.confirmReadyInTransaction(client,row,row.session_key,op.binding_version,evidence.usableAt);
            state='confirmed';code='usable_access_confirmed';
          } catch(e) {
            if (!(e instanceof AccessError)) throw e;
            code='readiness_rejected';
          }
        }
      } else if (matches && evidence.state==='never_enabled' && evidence.generationRetired===true && evidence.sessionClosed===true) {
        const period=(await client.query('SELECT activation_at FROM pppoe_lab_periods WHERE subscription_id=$1',[row.subscription_id])).rows[0];
        if (period?.activation_at) code='effective_period_cannot_be_reset';
        else if (now<new Date(row.lease_until)) code='absence_safety_window_pending';
        else {
          await client.query("UPDATE pppoe_lab_admissions SET state='never_enabled',stopped_at=coalesce(stopped_at,$2) WHERE id=$1",[row.id,now]);
          state='never_enabled';code='never_enabled_fence_confirmed';
        }
      }
      const changed=(await client.query(`UPDATE pppoe_lab_operations SET state=$2,result_code=$3,lease_token=NULL,lease_until=NULL,
        next_attempt_at=$4,updated_at=$5 WHERE id=$1 RETURNING *`,[op.id,state,code,new Date(now.getTime()+5000),now])).rows[0];
      await this.operationEvent(client,changed);
    });
  }
  /** No automatic slot release after a missing Start. Only an explicit lab NAS
   * absence proof after the enforced provisional window permits rescheduling. */
  async confirmNeverEnabled(id: string,verifiedAbsent: boolean) {
    return this.tx(async client=>{
      const row=await this.lockAdmission(client,id);
      if ((await client.query('SELECT id FROM pppoe_lab_operations WHERE admission_id=$1',[id])).rows.length) throw deny('absence owned by provisioning operation');
      if (!verifiedAbsent || row.started_at || !['reserved','uncertain','never_enabled'].includes(row.state) || this.clock()<new Date(row.lease_until)) throw deny();
      await client.query("UPDATE pppoe_lab_admissions SET state='never_enabled' WHERE id=$1",[id]);
    });
  }
}
