jest.mock('../../../config/database');
jest.mock('../../../utils/crypto',() => ({ decrypt: (value: string) => value }));
import { query } from '../../../config/database';
import { fetchChannels, listPayHeroBanks, listPayHeroChannels, registerPayHeroBank } from '../payheroChannels';
import type { PayHeroConfig, Transport } from '../payheroAdapter';

const credentials = { username: 'fixture-api',password: 'fixture-secret' };
const connection = { version: 0,mode: 'sandbox',base_url: 'https://backend.payhero.co.ke',...credentials };
const config: PayHeroConfig = { id: 1,enabled: false,mode: 'sandbox',base_url: connection.base_url,channel_id: 1,account_id: 5000,public_origin: '',credentials_encrypted: JSON.stringify(credentials) };
const bank = { id: 'bank-fixture',name: 'Sample Bank',paybill: '522522' };
const channel = { id: 2429,channel_type: 'bank',account_id: 5000,short_code: '522522',account_number: '001280006242',description: 'Sample Bank',is_active: true };
const body = { connection,account_id: 5000,bank_id: bank.id,account_number: channel.account_number,description: channel.description,request_key: '00000000-0000-4000-8000-000000000001' };
let records: { target_key: unknown; request_key: unknown; fingerprint: unknown; state: string; channel?: unknown }[];
let providerChannels: unknown[], posts: number, loseReply: boolean;
const transport: Transport = async (url,options) => {
  if (options?.method === 'POST') { posts++; providerChannels.push(channel); if (loseReply) throw new Error('lost reply'); return new Response(JSON.stringify(channel),{ status: 200 }); }
  return new Response(JSON.stringify(String(url).includes('bank_paybills') ? { bank_paybills: [bank] } : { payment_channels: providerChannels,pagination: { next_page: null } }));
};
beforeEach(() => {
  jest.resetAllMocks(); records = []; providerChannels = []; posts = 0; loseReply = false;
  (query as jest.Mock).mockImplementation(async (sql: string,params: unknown[] = []) => {
    if (sql.includes('FROM billing_payhero_settings')) return [{ version: 0 }];
    if (sql.startsWith('INSERT INTO billing_payhero_channel_registrations')) {
      if (records.some((r) => r.target_key === params[0] || r.request_key === params[1])) return [];
      records.push({ target_key: params[0],request_key: params[1],fingerprint: params[2],state: 'pending' }); return [{ target_key: params[0] }];
    }
    if (sql.startsWith('SELECT * FROM billing_payhero_channel_registrations')) return records.filter((r) => r.target_key === params[0] || r.request_key === params[1]);
    if (sql.startsWith('UPDATE billing_payhero_channel_registrations')) {
      const row = records.find((r) => r.target_key === params[0]);
      if (row) { if (sql.includes("state='confirmed'")) { row.state = 'confirmed'; row.channel = JSON.parse(params[1] as string); } else if (row.state !== 'confirmed') row.state = 'uncertain'; }
      return [];
    }
    throw new Error('Unexpected query');
  });
});
test('loads bank directory before a collection channel or public origin is saved',async () => expect(await listPayHeroBanks(connection,transport)).toEqual({ banks: [bank] }));
test('loads registered channels without exposing other provider fields',async () => { providerChannels = [{ ...channel,private_token: 'do-not-expose' }]; expect(await listPayHeroChannels(connection,transport)).toEqual({ channels: [channel] }); });
test('saved credentials can be reused only for the same environment and origin',async () => {
  (query as jest.Mock).mockResolvedValue([{ ...config,version: 4 }]);
  expect((await listPayHeroBanks({ ...connection,version: 4,username: '',password: '' },transport)).banks).toHaveLength(1);
  await expect(listPayHeroBanks({ ...connection,version: 4,mode: 'live',username: '',password: '' },transport)).rejects.toMatchObject({ status: 400 });
});
test('rejects stale configuration before contacting the provider',async () => { const call = jest.fn(transport); await expect(listPayHeroBanks({ ...connection,version: 2 },call)).rejects.toMatchObject({ status: 409 }); expect(call).not.toHaveBeenCalled(); });
test.each([{ account_number: '' },{ account_id: 0 },{ bank_id: 'unknown' },{ account_number: '1/2' },{ request_key: 'invalid' },{ description: '' }])('invalid bank registration never sends a POST %#',async (change) => { await expect(registerPayHeroBank({ ...body,...change },'fixture',transport)).rejects.toMatchObject({ status: 400 }); expect(posts).toBe(0); });
test('registers using the directory shortcode, preserving leading account zeros',async () => {
  const call = jest.fn(transport);
  expect(await registerPayHeroBank(body,'fixture',call)).toEqual({ channel,existing: false });
  const sent = call.mock.calls.find(([,options]) => options?.method === 'POST')!;
  expect(JSON.parse(String(sent[1]?.body))).toEqual({ channel_type: 'bank',account_id: 5000,short_code: 522522,account_number: '001280006242',description: 'Sample Bank' });
  expect(records[0].state).toBe('confirmed');
  expect(await registerPayHeroBank(body,'fixture',transport)).toEqual({ channel,existing: true }); expect(posts).toBe(1);
});
test('an existing matching channel is reused without registering again',async () => { providerChannels = [channel]; expect((await registerPayHeroBank(body,'fixture',transport)).existing).toBe(true); expect(posts).toBe(0); });
test('lost registration reply recovers from the channel list without repeating POST',async () => {
  loseReply = true;
  await expect(registerPayHeroBank(body,'fixture',transport)).rejects.toMatchObject({ status: 502 }); expect(records[0].state).toBe('uncertain');
  expect((await registerPayHeroBank(body,'fixture',transport)).channel).toEqual(channel); expect(posts).toBe(1);
});
test('uncertain registration is not resent even with a new browser request key',async () => {
  loseReply = true; await expect(registerPayHeroBank(body,'fixture',transport)).rejects.toMatchObject({ status: 502 });
  providerChannels = [];
  await expect(registerPayHeroBank({ ...body,request_key: '00000000-0000-4000-8000-000000000002' },'fixture',transport)).rejects.toMatchObject({ status: 409 }); expect(posts).toBe(1);
});
test('a request key cannot be reused for a different bank account',async () => {
  await registerPayHeroBank(body,'fixture',transport);
  await expect(registerPayHeroBank({ ...body,account_number: 'other' },'fixture',transport)).rejects.toMatchObject({ status: 409 }); expect(posts).toBe(1);
});
test('bank registration cannot supply an arbitrary shortcode',async () => { await expect(registerPayHeroBank({ ...body,short_code: '1234' },'fixture',transport)).rejects.toMatchObject({ status: 400 }); expect(posts).toBe(0); });
test('channel listing follows numeric pages instead of provider-supplied URLs',async () => {
  const call = jest.fn(async (url) => new Response(JSON.stringify({ payment_channels: [channel],pagination: { next_page: String(url).includes('page=2') ? null : 2 } })));
  expect(await fetchChannels({ config,credentials },call)).toHaveLength(2);
  expect(String(call.mock.calls[1][0])).toBe('https://backend.payhero.co.ke/api/v2/payment_channels?page=2');
  await expect(fetchChannels({ config,credentials },async () => new Response(JSON.stringify({ payment_channels: [],pagination: { next_page: 'https://evil.example' } })))).rejects.toThrow('pagination');
});
test('malformed bank directory cannot be used to register a channel',async () => { await expect(listPayHeroBanks(connection,async () => new Response(JSON.stringify({ bank_paybills: [{ ...bank,paybill: 'invalid' }] })))).rejects.toMatchObject({ status: 502 }); });
