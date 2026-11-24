jest.mock('../../config/database');
jest.mock('../../modules/billing/serviceBindings',() => ({
  ...jest.requireActual('../../modules/billing/serviceBindings'),bindingRouters: jest.fn(),discoverServiceRouter: jest.fn(),saveServiceBinding: jest.fn(),
}));
jest.mock('../../modules/billing/serviceCredentials',() => ({
  ...jest.requireActual('../../modules/billing/serviceCredentials'),generateServiceCredentials: jest.fn(),
}));
jest.mock('../../modules/billing/customerServices',() => ({
  ...jest.requireActual('../../modules/billing/customerServices'),
  createServiceDraft: jest.fn(),listCustomerServices: jest.fn(),
}));
jest.mock('../../middleware/auth',() => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown },res: { sendStatus: (n: number) => void },next: () => void) => {
    if (!req.user) { res.sendStatus(401); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingCustomerServices';
import { createServiceDraft, listCustomerServices, parseServiceDraft } from '../../modules/billing/customerServices';
import { AccessError } from '../../modules/billing/accessPolicy';
import { generateServiceCredentials, parseCredentialInput } from '../../modules/billing/serviceCredentials';
import { bindingRouters, discoverServiceRouter, saveServiceBinding } from '../../modules/billing/serviceBindings';

const valid = { customer_id: 1,label: 'Home connection',reason: 'Initial setup',request_key: '11111111-1111-4111-8111-111111111111' };
function app(role?: string,scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req,_res,next) => { if (role) req.user = { userId: 1,username: 'fixture',role,...(scoped ? { siteRoles: { 1: 'admin' } } : {}) }; next(); });
  server.use('/',routes); return server;
}
beforeEach(() => jest.clearAllMocks());

test('router setup is restricted to fleet-admin sessions, including reads',async () => {
  const id = valid.request_key;
  for (const [role,scoped,status] of [[undefined,false,401],['viewer',false,403],['operator',false,403],['admin',true,403]] as const) {
    expect((await request(app(role,scoped)).get('/routers')).status).toBe(status);
    expect((await request(app(role,scoped)).post(`/${id}/discover`).send({ device_id: 1,version: 1 })).status).toBe(status);
    expect((await request(app(role,scoped)).post(`/${id}/binding`).send({})).status).toBe(status);
  }
  expect(bindingRouters).not.toHaveBeenCalled(); expect(discoverServiceRouter).not.toHaveBeenCalled(); expect(saveServiceBinding).not.toHaveBeenCalled();
});
test('router discovery accepts only managed-device selection and does not cache inventory',async () => {
  jest.mocked(bindingRouters).mockResolvedValueOnce([]);
  expect((await request(app('admin')).get('/routers')).headers['cache-control']).toBe('no-store');
  const body = { device_id: 4,version: 2 };
  jest.mocked(discoverServiceRouter).mockResolvedValueOnce({ id: valid.request_key,inventory: {} });
  expect((await request(app('admin')).post(`/${valid.request_key}/discover`).send(body)).status).toBe(200);
  expect(discoverServiceRouter).toHaveBeenCalledWith(valid.request_key,body);
  expect((await request(app('admin')).post(`/${valid.request_key}/discover`).send({ ...body,ip_address: '192.0.2.1' })).status).toBe(400);
});

test('only a fleet administrator can read or prepare services',async () => {
  for (const [role,scoped,status] of [[undefined,false,401],['viewer',false,403],['operator',false,403],['admin',true,403]] as const) {
    expect((await request(app(role,scoped)).get('/?customer_id=1')).status).toBe(status);
    expect((await request(app(role,scoped)).post('/').send(valid)).status).toBe(status);
    expect((await request(app(role,scoped)).post('/11111111-1111-4111-8111-111111111111/credentials').send({ version: 1,reason: 'Setup',request_key: valid.request_key })).status).toBe(status);
  }
  expect(createServiceDraft).not.toHaveBeenCalled(); expect(listCustomerServices).not.toHaveBeenCalled();
});
test('password responses are not cached and never accept client-supplied passwords',async () => {
  const body = { version: 1,reason: 'Initial password',request_key: valid.request_key };
  const id = '11111111-1111-4111-8111-111111111111';
  jest.mocked(generateServiceCredentials).mockResolvedValueOnce({ service: { id },password: 'fictional-password',replayed: false });
  const result = await request(app('admin')).post(`/${id}/credentials`).send(body);
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(result.headers.pragma).toBe('no-cache');
  expect(generateServiceCredentials).toHaveBeenCalledWith(id,body,'fixture');
  jest.clearAllMocks();
  expect((await request(app('admin')).post(`/${id}/credentials`).send({ ...body,password: 'injected' })).status).toBe(400);
  expect(generateServiceCredentials).not.toHaveBeenCalled();
});
test.each([{version:0},{version:'1'},{version:2147483647},{reason:''},{request_key:'bad'},{password:'bad'},{disconnect:true}])('invalid password operation is refused: %j',(fields) => {
  expect(() => parseCredentialInput({ version: 1,reason: 'Setup',request_key: valid.request_key,...fields })).toThrow(AccessError);
});
test('listing requires an explicit valid customer and prevents caching',async () => {
  for (const suffix of ['', '?customer_id=0','?customer_id=1&customer_id=2']) expect((await request(app('admin')).get('/'+suffix)).status).toBe(400);
  jest.mocked(listCustomerServices).mockResolvedValueOnce([]);
  const result = await request(app('admin')).get('/?customer_id=2');
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(listCustomerServices).toHaveBeenCalledWith(2);
});
test('normalizes PPPoE usernames and reports idempotent creation',async () => {
  const service = { id: 'service',state: 'draft' };
  jest.mocked(createServiceDraft).mockResolvedValueOnce({ service,replayed: false }).mockResolvedValueOnce({ service,replayed: true });
  const result = await request(app('admin')).post('/').send({ ...valid,username: ' Home-01 ' });
  expect(result.status).toBe(201);
  expect(createServiceDraft).toHaveBeenCalledWith({ ...valid,username: 'home-01' },'fixture');
  expect((await request(app('admin')).post('/').send(valid)).status).toBe(200);
});
test.each([{ customer_id: '1' },{ customer_id: 0 },{ request_key: 'invalid' },{ label: '' },{ reason: ' ' },
  { username: 'ab' },{ username: 'a@realm' },{ username: 'sim_reserved' },{ username: 'acct_reserved' },
  { username: 'bad space' },{ password: 'not-accepted' },{ state: 'active' },{ credentials_issued: true },{ router_id: 1 },{ mode: 'simulation' }])('rejects invalid or premature fields: %j',async (fields) => {
  expect((await request(app('admin')).post('/').send({ ...valid,...fields })).status).toBe(400);
  expect(createServiceDraft).not.toHaveBeenCalled();
});
test('username may be generated but explicit empty values are invalid',() => {
  expect(parseServiceDraft(valid).username).toBeNull();
  expect(() => parseServiceDraft({ ...valid,username: '' })).toThrow(AccessError);
});
test('returns conflicts without leaking database details',async () => {
  jest.mocked(createServiceDraft).mockRejectedValueOnce(new AccessError(409,'This username or request key is already in use'));
  const result = await request(app('admin')).post('/').send(valid);
  expect(result.status).toBe(409); expect(result.body).toEqual({ error: 'This username or request key is already in use' });
});
