import { AccessError } from './accessPolicy';
import { phoneNumber } from './customersPayments';

export interface PayHeroConfig { id: number; enabled: boolean; mode: 'sandbox' | 'live'; base_url: string; channel_id: number; account_id: number | null; public_origin: string; credentials_encrypted: string }
export interface PayHeroCallback { amount_minor: number | null; external_reference: string; checkout_id: string; receipt: string; phone: string; result_code: number | null }
export type Transport = typeof fetch;
export const asObject = (value: unknown): Record<string,unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
export const bounded = (v: unknown,max = 160): string => typeof v === 'string' ? v.slice(0,max) : '';
export function providerOrigin(v: unknown): string {
  if (typeof v !== 'string' || v.length>250) throw new AccessError(400,'Enter the PayHero API origin');
  let u: URL; try { u = new URL(v); } catch { throw new AccessError(400,'Enter a valid PayHero API origin'); }
  const hosts = ['backend.payhero.co.ke','api.payhero.africa',...(process.env.PAYHERO_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.port && u.port !== '443') || !hosts.includes(u.hostname)) throw new AccessError(400,'Use an approved HTTPS PayHero host. Add a provider-issued sandbox host to PAYHERO_ALLOWED_HOSTS on the server first.');
  return u.origin;
}
export function callbackOrigin(v: unknown): string {
  let u: URL; try { u = new URL(String(v)); } catch { throw new AccessError(400,'Enter the public HTTPS application origin'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.origin.length>250 || !u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) || u.hostname.endsWith('.local')) throw new AccessError(400,'Callbacks require a public HTTPS application origin');
  return u.origin;
}
export function providerAmount(minor: unknown): number {
  if (!Number.isSafeInteger(minor) || (minor as number)<=0 || (minor as number)%100 !== 0) throw new AccessError(400,'PayHero Kenya STK requires a whole-KES price. Update the package price before collecting payment.');
  return (minor as number)/100;
}
function minorAmount(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(\.\d{1,2})?$/.test(String(value))) return null;
  const [major,cents = ''] = String(value).split('.'); const n = Number(major)*100+Number(cents.padEnd(2,'0'));
  return Number.isSafeInteger(n) ? n : null;
}
export function parsePayHeroCallback(body: unknown): PayHeroCallback {
  const r = asObject(asObject(body).response);
  let phone = ''; try { phone = phoneNumber(r.Phone)!; } catch { /* kept invalid for verification */ }
  return { amount_minor: minorAmount(r.Amount),external_reference: bounded(r.ExternalReference),checkout_id: bounded(r.CheckoutRequestID),receipt: bounded(r.MpesaReceiptNumber),phone,result_code: r.ResultCode === 0 || r.ResultCode === '0' ? 0 : typeof r.ResultCode === 'number' ? r.ResultCode : null };
}
export async function payHeroRequest(config: PayHeroConfig,credentials: { username: string; password: string },path: string,body?: unknown,transport: Transport = fetch) {
  const response = await transport(`${config.base_url}/api/v2/${path}`,{ method: body === undefined ? 'GET' : 'POST',redirect: 'error',signal: AbortSignal.timeout(15000),headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,'Content-Type': 'application/json' },...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Bound provider replies; do not log their raw content or request headers.
  const reader = response.body?.getReader(); let size = 0; const chunks: Buffer[] = [];
  if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size>131072) { await reader.cancel(); throw new Error('Provider reply exceeded limit'); } chunks.push(Buffer.from(chunk.value)); }
  let data: Record<string,unknown>; try { data = asObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new Error('Provider returned an unreadable reply'); }
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  return data;
}
export function checkPaymentEvidence(status: Record<string,unknown>,callback: PayHeroCallback | undefined,attempt: { external_reference: string; provider_reference: string; checkout_id: string | null },purchase: { amount_minor: number; payer_phone: string; currency: string },config: PayHeroConfig): { state: 'pending' | 'succeeded' | 'failed' | 'review'; reason: string; receipt?: string } {
  if (status.reference !== attempt.provider_reference) return { state: 'review',reason: 'Provider reference does not match the saved payment attempt' };
  if (status.provider !== 'm-pesa') return { state: 'review',reason: 'Unexpected payment provider' };
  const outcome = String(status.status ?? '').toUpperCase();
  if (outcome === 'FAILED') return { state: 'failed',reason: 'Payment was unsuccessful' };
  if (outcome !== 'SUCCESS') return { state: 'pending',reason: 'Waiting for provider confirmation' };
  if (status.success !== true) return { state: 'review',reason: 'Conflicting provider payment outcome' };
  if (!callback) return { state: 'pending',reason: 'Waiting for the authenticated callback evidence' };
  if (callback.result_code !== 0 || callback.external_reference !== attempt.external_reference || callback.amount_minor !== purchase.amount_minor || callback.phone !== purchase.payer_phone || (attempt.checkout_id && callback.checkout_id !== attempt.checkout_id)) return { state: 'review',reason: 'Callback details do not match the purchased terms' };
  const receipt = bounded(status.provider_reference) || bounded(status.third_party_reference);
  if (!receipt || receipt !== callback.receipt || (status.CheckoutRequestID && status.CheckoutRequestID !== attempt.checkout_id) || (status.currency !== undefined && status.currency !== purchase.currency) || (status.amount !== undefined && minorAmount(status.amount) !== purchase.amount_minor) || (status.channel_id !== undefined && Number(status.channel_id) !== config.channel_id) || (status.account_id !== undefined && config.account_id !== null && Number(status.account_id) !== config.account_id)) return { state: 'review',reason: 'Provider receipt or transaction details do not match' };
  return { state: 'succeeded',reason: 'Payment verified against provider status and callback evidence',receipt };
}
