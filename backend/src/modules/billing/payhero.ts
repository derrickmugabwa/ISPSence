import { supportsService } from './serviceFunding';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';
import { AccessError, lockCustomer, validUuid, versionNumber } from './accessPolicy';
import { phoneNumber } from './customersPayments';
import { fetchChannels } from './payheroChannels';
import { preparePaidAccess } from './paymentReceipts';
import { asObject, bounded, callbackOrigin, checkPaymentEvidence, parsePayHeroCallback, payHeroRequest, providerAmount, providerOrigin, type PayHeroConfig, type Transport } from './payheroAdapter';

export const hashToken = (s: string) => createHash('sha256').update(s).digest('hex');
const secretPattern = /^[a-f0-9]{64}$/;
type Attempt = { id: string; purchase_id: string; config_id: number; mode: 'sandbox' | 'live'; external_reference: string; provider_reference: string | null; checkout_id: string | null; state: string; callback_secret_encrypted: string | null; created_at: string };
type Purchase = { id: string; customer_id: number; package_id: number; payer_phone: string; amount_minor: number; currency: string; payment_status: string; package_snapshot: Record<string,unknown> };
async function event(client: PoolClient,attemptId: string | null,kind: string,actor: string,detail: unknown = {}) { await client.query('INSERT INTO billing_payhero_events(attempt_id,kind,actor,detail) VALUES($1,$2,$3,$4)',[attemptId,kind,actor,JSON.stringify(detail)]); }
export async function payHeroSettings() {
  const row = (await query(`SELECT s.version,c.id,c.enabled,c.mode,c.base_url,c.channel_id,c.account_id,c.public_origin,c.created_at,c.actor,(c.credentials_encrypted IS NOT NULL) AS credentials_configured FROM billing_payhero_settings s LEFT JOIN billing_payhero_configs c ON c.id=s.config_id WHERE s.id=1`))[0];
  return row ?? { version: 0,enabled: false,mode: 'sandbox',credentials_configured: false };
}
export async function savePayHeroSettings(body: unknown,actor: string) {
  const b = asObject(body); const version = versionNumber(b.version);
  if (Object.keys(b).some((key) => !['version','enabled','mode','base_url','channel_id','account_id','public_origin','username','password'].includes(key)) || typeof b.enabled !== 'boolean' || !['sandbox','live'].includes(String(b.mode)) || !Number.isInteger(b.channel_id) || Number(b.channel_id)<1 || Number(b.channel_id)>2147483647 || (b.account_id !== null && (!Number.isInteger(b.account_id) || Number(b.account_id)<1 || Number(b.account_id)>2147483647))) throw new AccessError(400,'Choose valid PayHero settings, mode and channel');
  const base = providerOrigin(b.base_url), origin = callbackOrigin(b.public_origin);
  if ((b.username !== undefined && typeof b.username !== 'string') || (b.password !== undefined && typeof b.password !== 'string')) throw new AccessError(400,'Invalid credentials');
  const username = bounded(b.username,256), password = bounded(b.password,512);
  if (typeof b.username === 'string' && b.username.length>256 || typeof b.password === 'string' && b.password.length>512) throw new AccessError(400,'API credentials are too long');
  if (username.includes(':') || (Boolean(username) !== Boolean(password))) throw new AccessError(400,'Enter both API username and password');
  await transaction(async (client) => {
    const pointer = (await client.query('SELECT * FROM billing_payhero_settings WHERE id=1 FOR UPDATE')).rows[0];
    if (pointer.version !== version) throw new AccessError(409,'PayHero settings changed. Reload before saving.');
    const old = pointer.config_id ? (await client.query<PayHeroConfig>('SELECT * FROM billing_payhero_configs WHERE id=$1',[pointer.config_id])).rows[0] : undefined;
    if (!username && (!old || old.mode !== b.mode || old.base_url !== base)) throw new AccessError(400,'Enter credentials for this environment. Sandbox mode requires provider-issued sandbox credentials.');
    const credentials = username ? encrypt(JSON.stringify({ username,password })) : old!.credentials_encrypted;
    const saved = (await client.query(`INSERT INTO billing_payhero_configs(enabled,mode,base_url,channel_id,account_id,public_origin,credentials_encrypted,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[b.enabled,b.mode,base,b.channel_id,b.account_id,origin,credentials,actor])).rows[0];
    await client.query('UPDATE billing_payhero_settings SET config_id=$1,version=version+1 WHERE id=1',[saved.id]);
    await event(client,null,'settings_saved',actor,{ config_id: saved.id,mode: b.mode,enabled: b.enabled });
  });
  return payHeroSettings();
}
async function activeConfig(client: PoolClient): Promise<PayHeroConfig> {
  const c = (await client.query<PayHeroConfig>('SELECT c.* FROM billing_payhero_settings s JOIN billing_payhero_configs c ON c.id=s.config_id WHERE s.id=1 FOR SHARE OF s')).rows[0];
  if (!c?.enabled) throw new AccessError(409,'PayHero collection is not enabled');
  return c;
}
export async function collectionAvailability() {
  const row = (await query<{ enabled: boolean; mode: string }>('SELECT c.enabled,c.mode FROM billing_payhero_settings s JOIN billing_payhero_configs c ON c.id=s.config_id WHERE s.id=1'))[0];
  return { enabled: row?.enabled ?? false,mode: row?.mode ?? 'sandbox' };
}
export async function testPayHeroConnection(transport: Transport = fetch) {
  const c = (await query<PayHeroConfig>('SELECT c.* FROM billing_payhero_settings s JOIN billing_payhero_configs c ON c.id=s.config_id WHERE s.id=1'))[0];
  if (!c) throw new AccessError(409,'Save PayHero settings first');
  try {
    const channels = await fetchChannels({ config: c,credentials: JSON.parse(decrypt(c.credentials_encrypted)) },transport);
    const selected = channels.find((row) => row.id === c.channel_id);
    return { connected: true,channel_found: !!selected,channel_active: selected?.is_active === true,mode: c.mode,channel_type: bounded(selected?.channel_type),message: selected?.is_active === true ? 'Credentials accepted and collection channel is active. No payment was initiated.' : 'Credentials accepted. The configured channel was not active in this response; check the channel ID and provider dashboard.' };
  } catch { throw new AccessError(502,'PayHero connection could not be verified. Check the API origin, credentials and sandbox access.'); }
}
async function reserve(client: PoolClient,purchase: Purchase,config: PayHeroConfig,key: string,actor: string): Promise<Attempt> {
  providerAmount(purchase.amount_minor);
  if (!/^\+254[17]\d{8}$/.test(purchase.payer_phone)) throw new AccessError(400,'Kenya M-Pesa collection requires a Kenyan mobile number');
  const previous = (await client.query<Attempt>('SELECT * FROM billing_payhero_attempts WHERE purchase_id=$1 AND mode=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[purchase.id,config.mode])).rows[0];
  if (previous && previous.state !== 'failed') return previous;
  if (purchase.payment_status === 'paid' || purchase.payment_status === 'refunded') throw new AccessError(409,'This payment record cannot be charged again');
  const used = (await client.query('SELECT purchase_id FROM billing_payhero_attempts WHERE request_key=$1',[key])).rows[0];
  if (used) throw new AccessError(409,'This attempt request key was already used. Refresh the payment.');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payhero:${config.mode}:${purchase.payer_phone}`]);
  if ((await client.query(`SELECT a.id FROM billing_payhero_attempts a JOIN billing_purchases p ON p.id=a.purchase_id WHERE p.payer_phone=$1 AND a.mode=$2 AND a.created_at>now()-interval '60 seconds' LIMIT 1`,[purchase.payer_phone,config.mode])).rows.length) throw new AccessError(429,'Wait a minute before requesting another payment prompt for this number');
  const id = randomUUID(), secret = randomBytes(32).toString('hex');
  const row = (await client.query<Attempt>(`INSERT INTO billing_payhero_attempts(id,purchase_id,config_id,request_key,mode,external_reference,state,callback_hash,callback_secret_encrypted) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8) RETURNING *`,[id,purchase.id,config.id,key,config.mode,`PH-${id.replace(/-/g,'')}`,hashToken(secret),encrypt(secret)])).rows[0];
  await event(client,id,'collection_queued',actor,{ mode: config.mode });
  if (config.mode === 'live' && purchase.payment_status === 'failed') await client.query("UPDATE billing_purchases SET payment_status='pending' WHERE id=$1",[purchase.id]);
  return row;
}
export async function initiateAdminPayment(purchaseId: string,key: unknown,actor: string,expectedMode?: string) {
  if (!validUuid(purchaseId) || !validUuid(key)) throw new AccessError(400,'A valid payment and request key are required');
  const p = (await query<Purchase>('SELECT * FROM billing_purchases WHERE id=$1',[purchaseId]))[0]; if (!p) throw new AccessError(404,'Payment not found');
  await transaction(async (client) => { await lockCustomer(client,p.customer_id); const purchase = (await client.query<Purchase>('SELECT * FROM billing_purchases WHERE id=$1 FOR UPDATE',[purchaseId])).rows[0]; const config = await activeConfig(client); if (expectedMode && config.mode !== expectedMode) throw new AccessError(409,'Payment environment changed. Review the current environment before requesting payment.'); await reserve(client,purchase,config,key,actor); });
  return adminPaymentDetail(purchaseId);
}
export async function adminPaymentDetail(purchaseId: string) {
  const attempts = await query('SELECT id,purchase_id,mode,state,external_reference,provider_reference,checkout_id,receipt,last_error,checks,created_at,updated_at FROM billing_payhero_attempts WHERE purchase_id=$1 ORDER BY created_at DESC,id DESC',[purchaseId]);
  const history = await query('SELECT e.kind,e.actor,e.detail,e.created_at FROM billing_payhero_events e JOIN billing_payhero_attempts a ON a.id=e.attempt_id WHERE a.purchase_id=$1 ORDER BY e.id DESC LIMIT 50',[purchaseId]);
  return { attempts,history };
}
export async function recheckPayment(id: string) {
  if (!validUuid(id)) throw new AccessError(400,'Invalid payment attempt');
  await query("UPDATE billing_payhero_attempts SET next_check_at=now() WHERE id=$1 AND state<>'succeeded'",[id]);
}
export async function receivePayHeroCallback(id: string,secret: string,body: unknown) {
  if (!validUuid(id) || !secretPattern.test(secret)) throw new AccessError(404,'Not found');
  const callback = parsePayHeroCallback(body);
  return transaction(async (client) => {
    const attempt = (await client.query<Attempt>('SELECT * FROM billing_payhero_attempts WHERE id=$1 AND callback_hash=$2',[id,hashToken(secret)])).rows[0];
    if (!attempt) throw new AccessError(404,'Not found');
    if (callback.external_reference !== attempt.external_reference) throw new AccessError(400,'Callback reference does not match');
    const payload = JSON.stringify(callback);
    const inserted = await client.query('INSERT INTO billing_payhero_callbacks(attempt_id,digest,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[id,hashToken(payload),payload]);
    if (inserted.rows.length) {
      await client.query("UPDATE billing_payhero_attempts SET next_check_at=now() WHERE id=$1 AND state<>'succeeded'",[id]);
      await event(client,id,'callback_stored','payhero:callback');
      if (attempt.state === 'succeeded' && callback.result_code !== 0) await event(client,id,'post_success_callback_review','payhero:callback');
    }
    return { received: true };
  });
}
async function fulfill(client: PoolClient,purchase: Purchase,attempt: Attempt,receipt: string) {
  if (purchase.payment_status === 'paid') { await event(client,attempt.id,'additional_payment_review','system:payhero'); return false; }
  if (purchase.payment_status === 'refunded') return false;
  if ((await client.query("SELECT 1 FROM billing_payment_receipts WHERE method IN ('payhero','manual_mpesa') AND upper(reference)=upper($1) LIMIT 1",[receipt])).rows.length) { await event(client,attempt.id,'duplicate_receipt_review','system:payhero'); return false; }
  await client.query(`INSERT INTO billing_payment_receipts(id,purchase_id,request_key,method,amount_minor,reference,paid_at,actor,notes,fingerprint) VALUES($1,$2,$1,'payhero',$3,$4,clock_timestamp(),'system:payhero','Verified provider status and callback',$5)`,[attempt.id,purchase.id,purchase.amount_minor,receipt,attempt.id]);
  await preparePaidAccess(client,purchase,'system:payhero');
  return true;
}
async function finishAttempt(attempt: Attempt,state: string,reason: string,receipt?: string) {
  const purchase = (await query<Purchase>('SELECT * FROM billing_purchases WHERE id=$1',[attempt.purchase_id]))[0];
  await transaction(async (client) => {
    await lockCustomer(client,purchase.customer_id);
    const p = (await client.query<Purchase>('SELECT * FROM billing_purchases WHERE id=$1 FOR UPDATE',[purchase.id])).rows[0];
    const a = (await client.query<Attempt>('SELECT * FROM billing_payhero_attempts WHERE id=$1 FOR UPDATE',[attempt.id])).rows[0];
    if (a.state === 'succeeded') return;
    if (state === 'succeeded' && receipt) {
      const inserted = await client.query('INSERT INTO billing_payhero_receipts(mode,receipt,attempt_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt',[a.mode,receipt,a.id]);
      if (!inserted.rows.length) { state = 'review'; reason = 'Receipt already belongs to another payment attempt'; }
      else if (a.mode === 'live' && !await fulfill(client,p,a,receipt)) { state = 'review'; reason = 'Additional or reversed payment requires review'; }
    }
    const terminal = ['succeeded','failed','review'].includes(state);
    await client.query("UPDATE billing_payhero_attempts SET state=$1,last_error=$2,receipt=coalesce($3,receipt),locked_until=NULL,next_check_at=CASE WHEN $4 THEN NULL ELSE now()+interval '30 seconds' END,checks=checks+1,updated_at=now() WHERE id=$5",[state,reason,receipt ?? null,terminal,a.id]);
    if (a.mode === 'live' && state === 'review' && p.payment_status !== 'paid' && p.payment_status !== 'refunded') await client.query("UPDATE billing_purchases SET payment_status='needs_review' WHERE id=$1",[p.id]);
    if (a.mode === 'live' && state === 'failed' && p.payment_status === 'pending') await client.query("UPDATE billing_purchases SET payment_status='failed' WHERE id=$1",[p.id]);
    if (a.state !== state) await event(client,a.id,state,'system:payhero',{ reason });
  });
}
/** Each queued request is dispatched once. A lost reply becomes uncertain, never a new POST. */
export async function processPayHeroAttempt(id?: string,transport: Transport = fetch): Promise<boolean> {
  const claimed = await transaction(async (client) => {
    const a = (await client.query<Attempt>(`SELECT * FROM billing_payhero_attempts WHERE next_check_at<=now() AND (locked_until IS NULL OR locked_until<now()) AND ($1::uuid IS NULL OR id=$1) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1`,[id ?? null])).rows[0];
    if (!a) return null;
    await client.query("UPDATE billing_payhero_attempts SET locked_until=now()+interval '60 seconds',state=CASE WHEN state='queued' THEN 'dispatching' ELSE state END WHERE id=$1",[a.id]);
    return a;
  });
  if (!claimed) return false;
  const a = claimed;
  try {
    const config = (await query<PayHeroConfig>('SELECT * FROM billing_payhero_configs WHERE id=$1',[a.config_id]))[0];
    const p = (await query<Purchase>('SELECT * FROM billing_purchases WHERE id=$1',[a.purchase_id]))[0];
    const credentials = JSON.parse(decrypt(config.credentials_encrypted)) as { username: string; password: string };
    if (a.state === 'queued') {
      const pointer = (await query('SELECT config_id FROM billing_payhero_settings WHERE id=1'))[0];
      if (!config.enabled || pointer.config_id !== config.id) { await finishAttempt(a,'failed','Collection settings changed before dispatch; no request was sent'); return true; }
      const secret = decrypt(a.callback_secret_encrypted!);
      const reply = await payHeroRequest(config,credentials,'payments',{ amount: providerAmount(p.amount_minor),phone_number: p.payer_phone.slice(1),channel_id: config.channel_id,provider: 'm-pesa',external_reference: a.external_reference,callback_url: `${config.public_origin}/api/payhero/callback/${a.id}/${secret}`,...(config.account_id === null ? {} : { account_id: config.account_id }) },transport);
      const reference = bounded(reply.reference), checkout = bounded(reply.CheckoutRequestID);
      if (reply.success !== true || !reference || !checkout) throw new Error('Initiation result is uncertain');
      await query("UPDATE billing_payhero_attempts SET provider_reference=$1,checkout_id=$2,state='pending',last_error='Waiting for payment confirmation',callback_secret_encrypted=NULL,locked_until=NULL,next_check_at=now()+interval '10 seconds',updated_at=now() WHERE id=$3",[reference,checkout,a.id]);
      return true;
    }
    const callbacks = await query<{ payload: ReturnType<typeof parsePayHeroCallback> }>('SELECT payload FROM billing_payhero_callbacks WHERE attempt_id=$1 ORDER BY id DESC LIMIT 20',[a.id]);
    const callback = callbacks.map((c) => c.payload).find((c) => c.result_code === 0);
    let reference = a.provider_reference;
    // A token-authenticated callback can recover a lost initiation reply by receipt lookup.
    if (!reference && callback?.receipt && callback.external_reference === a.external_reference && callback.amount_minor === p.amount_minor && callback.phone === p.payer_phone) {
      const recovered = await payHeroRequest(config,credentials,`transaction-status?reference=${encodeURIComponent(callback.receipt)}`,undefined,transport);
      if (bounded(recovered.reference) && (recovered.provider_reference === callback.receipt || recovered.third_party_reference === callback.receipt)) {
        reference = bounded(recovered.reference); a.checkout_id = callback.checkout_id;
        await query('UPDATE billing_payhero_attempts SET provider_reference=$1,checkout_id=$2 WHERE id=$3',[reference,a.checkout_id,a.id]);
      }
    }
    if (!reference) { await finishAttempt(a,Date.now()-new Date(a.created_at).getTime()>86400000 ? 'review' : 'uncertain','Initiation outcome is unknown. Do not submit another charge.'); return true; }
    const result = await payHeroRequest(config,credentials,`transaction-status?reference=${encodeURIComponent(reference)}`,undefined,transport);
    const verdict = checkPaymentEvidence(result,callback,{ ...a,provider_reference: reference },p,config);
    if (verdict.state === 'pending' && Date.now()-new Date(a.created_at).getTime()>86400000) { verdict.state = 'review'; verdict.reason = 'Payment still unresolved after 24 hours'; }
    await finishAttempt(a,verdict.state,verdict.reason,verdict.receipt);
  } catch {
    if (Date.now()-new Date(a.created_at).getTime()>86400000) { await finishAttempt(a,'review','Provider result could not be confirmed after 24 hours. Do not charge again.'); return true; }
    await query("UPDATE billing_payhero_attempts SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE state END,last_error='Provider communication could not be confirmed; reconciliation will retry',locked_until=NULL,next_check_at=now()+interval '60 seconds',checks=checks+1,updated_at=now() WHERE id=$1",[a.id]);
  }
  return true;
}
export function startPayHeroWorker() {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { for (let i=0;i<5;i++) if (!await processPayHeroAttempt()) break; } catch { console.warn('PayHero reconciliation deferred'); } finally { running = false; } };
  const timer = setInterval(() => { void tick(); },5000); timer.unref();
}

export async function publicCheckout(slug: string,body: unknown) {
  const b = asObject(body);
  if (!validUuid(b.request_key) || typeof b.checkout_token !== 'string' || !secretPattern.test(b.checkout_token) || !['sandbox','live'].includes(String(b.mode)) || [b.package_id,b.package_version].some((value) => !Number.isInteger(value) || Number(value)<1 || Number(value)>2147483647) || Object.keys(b).some((key) => !['package_id','package_version','payer_phone','request_key','checkout_token','mode'].includes(key))) throw new AccessError(400,'Invalid checkout details');
  let phone: string; try { phone = phoneNumber(b.payer_phone)!; } catch { throw new AccessError(400,'Enter a valid M-Pesa phone number'); }
  const purchaseId = await transaction(async (client) => {
    // Serializes retries before allocating a customer or initiating a payment.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[b.request_key]);
    const existing = (await client.query('SELECT p.*,x.token_hash,x.portal_id,x.mode AS checkout_mode FROM billing_purchases p JOIN billing_payhero_checkouts x ON x.purchase_id=p.id WHERE p.request_key=$1',[b.request_key])).rows[0];
    const portal = (await client.query('SELECT id,published_config FROM billing_portals WHERE slug=$1 FOR SHARE',[slug])).rows[0];
    if (!portal?.published_config) throw new AccessError(404,'Portal unavailable');
    if (existing) {
      if (existing.token_hash !== hashToken(b.checkout_token as string) || existing.portal_id !== portal.id || existing.package_id !== b.package_id || existing.payer_phone !== phone || existing.package_snapshot.package_version !== b.package_version || existing.checkout_mode !== b.mode) throw new AccessError(409,'This checkout key belongs to different details');
      return existing.id as string;
    }
    if ((await client.query('SELECT id FROM billing_purchases WHERE request_key=$1',[b.request_key])).rows.length) throw new AccessError(409,'This checkout key is already in use');
    const config = await activeConfig(client);
    if (config.mode !== b.mode) throw Object.assign(new AccessError(409,'Payment environment changed. Review the checkout before paying.'),{ code: 'environment_changed' });
    if (!portal.published_config.show_packages || !portal.published_config.package_ids.includes(b.package_id)) throw new AccessError(404,'Package unavailable');
    const offer = (await client.query('SELECT * FROM billing_packages WHERE id=$1 FOR SHARE',[b.package_id])).rows[0];
    if (!offer?.enabled || !supportsService(offer,'hotspot') || offer.version !== b.package_version) throw Object.assign(new AccessError(409,'Package terms changed. Reload and review the price.'),{ code: 'package_changed' });
    providerAmount(offer.amount_minor);
    const customer = (await client.query('INSERT INTO billing_customers(full_name,phone,notes) VALUES($1,$2,$3) RETURNING id',[`Hotspot customer ${phone.slice(-4)}`,phone,'Created through portal checkout; identity not verified for account merging.'])).rows[0];
    const id = randomUUID(), snapshot = { fup_policy: offer.fup_policy ?? null,name: offer.name,package_version: offer.version,amount_minor: offer.amount_minor,currency: offer.currency,duration_value: offer.duration_value,duration_unit: offer.duration_unit,download_bps: Number(offer.download_bps),upload_bps: Number(offer.upload_bps),allowance_bytes: offer.allowance_bytes === null ? null : Number(offer.allowance_bytes),device_limit: 1,timezone: process.env.TZ || 'Africa/Nairobi',start_policy: 'access_ready',calendar_rule: 'clamp_to_last_day' };
    const purchase = (await client.query<Purchase>('INSERT INTO billing_purchases(id,reference,request_key,customer_id,package_id,payer_phone,amount_minor,currency,package_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,`PAY-${id.replace(/-/g,'').slice(0,12).toUpperCase()}`,b.request_key,customer.id,offer.id,phone,offer.amount_minor,offer.currency,JSON.stringify(snapshot)])).rows[0];
    await client.query('INSERT INTO billing_payhero_checkouts(purchase_id,portal_id,token_hash,mode) VALUES($1,$2,$3,$4)',[id,portal.id,hashToken(b.checkout_token as string),config.mode]);
    await reserve(client,purchase,config,b.request_key as string,'portal:checkout');
    return id;
  });
  return publicCheckoutStatus(purchaseId,b.checkout_token as string);
}
export async function publicCheckoutStatus(id: string,token: string) {
  if (!validUuid(id) || !secretPattern.test(token)) throw new AccessError(404,'Checkout not found');
  const p = (await query(`SELECT p.id,p.reference,p.amount_minor,p.currency,p.payment_status,p.access_status FROM billing_purchases p JOIN billing_payhero_checkouts x ON x.purchase_id=p.id WHERE p.id=$1 AND x.token_hash=$2`,[id,hashToken(token)]))[0];
  if (!p) throw new AccessError(404,'Checkout not found');
  const a = (await query('SELECT mode,state,last_error,receipt,updated_at FROM billing_payhero_attempts WHERE purchase_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id]))[0];
  return { ...p,attempt: a };
}
export async function retryPublicCheckout(id: string,token: string,key: unknown) {
  await publicCheckoutStatus(id,token);
  const checkout = (await query<{ mode: string }>('SELECT mode FROM billing_payhero_checkouts WHERE purchase_id=$1',[id]))[0];
  return initiateAdminPayment(id,key,'portal:retry',checkout.mode).then(() => publicCheckoutStatus(id,token));
}
