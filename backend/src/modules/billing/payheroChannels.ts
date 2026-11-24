import { createHash } from 'crypto';
import { query } from '../../config/database';
import { decrypt } from '../../utils/crypto';
import { AccessError, validUuid, versionNumber } from './accessPolicy';
import { asObject, bounded, payHeroRequest, providerOrigin, type PayHeroConfig, type Transport } from './payheroAdapter';

export interface PayHeroChannel {
  id: number; channel_type: string; account_id: number | null; short_code: string;
  account_number: string; description: string; is_active: boolean;
}
interface Bank { id: string; name: string; paybill: string }
interface Connection { config: PayHeroConfig; credentials: { username: string; password: string } }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positiveId = (value: unknown): value is number => Number.isInteger(value) && Number(value)>0 && Number(value)<=2147483647;
const scalar = (value: unknown) => typeof value === 'number' ? String(value) : bounded(value,160);

// Accept draft credentials so the first channel can be created before saving a collection channel.
async function connection(body: unknown): Promise<Connection> {
  const b = asObject(body), version = versionNumber(b.version), base = providerOrigin(b.base_url);
  if (!['sandbox','live'].includes(String(b.mode)) || Object.keys(b).some((key) => !['version','mode','base_url','username','password'].includes(key))) throw new AccessError(400,'Invalid PayHero connection');
  const username = typeof b.username === 'string' ? b.username : '', password = typeof b.password === 'string' ? b.password : '';
  if (typeof b.username !== 'string' || typeof b.password !== 'string' || username.length>256 || password.length>512 || username.includes(':') || Boolean(username) !== Boolean(password)) throw new AccessError(400,'Enter both API username and password');
  const saved = (await query<PayHeroConfig & { version: number }>('SELECT c.*,s.version FROM billing_payhero_settings s LEFT JOIN billing_payhero_configs c ON c.id=s.config_id WHERE s.id=1'))[0];
  if ((saved?.version ?? 0) !== version) throw new AccessError(409,'PayHero settings changed. Reload before managing channels.');
  if (!username && (!saved?.credentials_encrypted || saved.mode !== b.mode || saved.base_url !== base)) throw new AccessError(400,'Enter credentials for this environment before loading channels');
  return {
    config: { id: saved?.id ?? 0,enabled: false,mode: b.mode as 'sandbox' | 'live',base_url: base,channel_id: 0,account_id: null,public_origin: '',credentials_encrypted: '' },
    credentials: username ? { username,password } : JSON.parse(decrypt(saved.credentials_encrypted)),
  };
}

export function channelFromProvider(value: unknown): PayHeroChannel {
  const c = asObject(value);
  if (!positiveId(c.id) || !['bank','till','paybill','wallet'].includes(String(c.channel_type)) || typeof c.is_active !== 'boolean' || (c.account_id != null && !positiveId(c.account_id))) throw new Error('Invalid channel response');
  return { id: c.id,channel_type: String(c.channel_type),account_id: c.account_id == null ? null : Number(c.account_id),short_code: scalar(c.short_code),account_number: scalar(c.account_number),description: bounded(c.description),is_active: c.is_active };
}

export async function fetchChannels(c: Connection,transport: Transport = fetch): Promise<PayHeroChannel[]> {
  const channels: PayHeroChannel[] = [], pages = new Set<number>();
  let page = 1;
  for (let count=0;count<25;count++) {
    if (pages.has(page)) throw new Error('Repeated channel page');
    pages.add(page);
    const result = await payHeroRequest(c.config,c.credentials,`payment_channels${page === 1 ? '' : `?page=${page}`}`,undefined,transport);
    if (!Array.isArray(result.payment_channels)) throw new Error('Missing channel list');
    channels.push(...result.payment_channels.map(channelFromProvider));
    const pagination = asObject(result.pagination), next = pagination.next_page;
    if (next == null) {
      if (Number(pagination.num_pages)>page) throw new Error('Incomplete channel pagination');
      return channels;
    }
    if (!/^\d+$/.test(String(next)) || !positiveId(Number(next)) || Number(next)<=page) throw new Error('Invalid channel pagination');
    page = Number(next);
  }
  throw new Error('Channel list exceeds page limit');
}
async function fetchBanks(c: Connection,transport: Transport): Promise<Bank[]> {
  const result = await payHeroRequest(c.config,c.credentials,'bank_paybills',undefined,transport);
  if (!Array.isArray(result.bank_paybills) || result.bank_paybills.length>2000) throw new Error('Invalid bank directory');
  return result.bank_paybills.map((value) => {
    const b = asObject(value), id = bounded(b.id), name = bounded(b.name), paybill = scalar(b.paybill);
    if (!id || !name || !/^\d{1,12}$/.test(paybill)) throw new Error('Invalid bank directory entry');
    return { id,name,paybill };
  });
}
export async function listPayHeroChannels(body: unknown,transport: Transport = fetch) {
  const c = await connection(body);
  try { return { channels: await fetchChannels(c,transport) }; }
  catch { throw new AccessError(502,'Could not load PayHero channels. Check the connection and try again.'); }
}
export async function listPayHeroBanks(body: unknown,transport: Transport = fetch) {
  const c = await connection(body);
  try { return { banks: await fetchBanks(c,transport) }; }
  catch { throw new AccessError(502,'Could not load the PayHero bank directory. Check the connection and try again.'); }
}
export async function registerPayHeroBank(body: unknown,actor: string,transport: Transport = fetch) {
  const b = asObject(body);
  if (Object.keys(b).some((key) => !['connection','account_id','bank_id','account_number','description','request_key'].includes(key)) || !validUuid(b.request_key) || !positiveId(b.account_id) || typeof b.bank_id !== 'string' || b.bank_id.length>160 || typeof b.account_number !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(b.account_number) || typeof b.description !== 'string' || !b.description.trim() || b.description.length>160 || [...b.description].some((char) => char.charCodeAt(0)<32 || char.charCodeAt(0) === 127)) throw new AccessError(400,'Enter a bank, PayHero account ID, account number and description');
  const c = await connection(b.connection);
  let banks: Bank[], channels: PayHeroChannel[];
  try { banks = await fetchBanks(c,transport); channels = await fetchChannels(c,transport); }
  catch { throw new AccessError(502,'Could not verify bank and existing channels. No registration was sent.'); }
  const bank = banks.find((row) => row.id === b.bank_id);
  if (!bank) throw new AccessError(400,'Choose a bank from the current PayHero directory');
  const payload = { channel_type: 'bank',account_id: b.account_id,short_code: Number(bank.paybill),account_number: b.account_number,description: b.description.trim() };
  const target = digest([c.config.base_url,c.config.mode,c.credentials.username,b.account_id,bank.paybill,b.account_number]);
  const fingerprint = digest(payload);
  const inserted = await query('INSERT INTO billing_payhero_channel_registrations(target_key,request_key,fingerprint,mode,actor) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING target_key',[target,b.request_key,fingerprint,c.config.mode,actor]);
  const records = await query<{ target_key: string; request_key: string; fingerprint: string; state: string; channel: PayHeroChannel | null }>('SELECT * FROM billing_payhero_channel_registrations WHERE target_key=$1 OR request_key=$2',[target,b.request_key]);
  const record = records.find((row) => row.request_key === b.request_key) ?? records[0];
  if (!record || record.target_key !== target || (record.request_key === b.request_key && record.fingerprint !== fingerprint)) throw new AccessError(409,'This registration key belongs to different details. Reopen the bank form.');
  const matches = (ch: PayHeroChannel) => ch.channel_type === 'bank' && ch.account_id === b.account_id && ch.short_code === bank.paybill && ch.account_number === b.account_number;
  const existing = channels.find(matches);
  if (existing) {
    await query("UPDATE billing_payhero_channel_registrations SET state='confirmed',channel=$2,updated_at=now() WHERE target_key=$1",[target,JSON.stringify(existing)]);
    return { channel: existing,existing: true };
  }
  if (!inserted.length) throw new AccessError(409,'Registration is already recorded but not visible in PayHero. Refresh channels and check again; no duplicate registration was sent.');
  try {
    const channel = channelFromProvider(await payHeroRequest(c.config,c.credentials,'payment_channels',payload,transport));
    if (!matches(channel)) throw new Error('Registered channel does not match the destination');
    await query("UPDATE billing_payhero_channel_registrations SET state='confirmed',channel=$2,updated_at=now() WHERE target_key=$1",[target,JSON.stringify(channel)]);
    return { channel,existing: false };
  } catch {
    await query("UPDATE billing_payhero_channel_registrations SET state='uncertain',updated_at=now() WHERE target_key=$1 AND state<>'confirmed'",[target]);
    throw new AccessError(502,'Registration could not be confirmed. Check again to look for the channel; it will not be registered twice automatically.');
  }
}
