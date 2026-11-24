jest.mock('../../modules/billing/accessPolicy',() => ({ ...jest.requireActual('../../modules/billing/accessPolicy'),lockCustomer: jest.fn(),lockSubscriptionCustomer: jest.fn(),checkReadiness: jest.fn() }));
jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingSubscriptions';
import { query, transaction } from '../../config/database';
import { expireSimulations, uuid } from '../../modules/billing/subscriptions';

const id = 'f9a5949c-cd35-47da-955b-2df4ee4c342a';
const purchase = '96c529b2-7c32-4692-9481-48a0b367d3a3';
const clientQuery = jest.fn();
const pending = { id, purchase_id: purchase, mode: 'simulation', status: 'pending_activation',
  package_snapshot: { duration_value: 1, duration_unit: 'hour', timezone: 'Africa/Nairobi' }, activation_at: null, expires_at: null };
function app(role?: string, scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { if (role) req.user = { userId: 1, username: 'fixture', role, ...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/', routes); return server;
}
beforeEach(() => {
  jest.resetAllMocks(); clientQuery.mockResolvedValue({ rows: [] });
  jest.mocked(transaction).mockImplementation((fn) => fn({ query: clientQuery } as never));
});
test.each([['viewer', false], ['operator', false], ['admin', true], [undefined, false]])('protect access data for %s scoped=%s', async (role, scoped) => {
  const server = app(role as string | undefined, scoped as boolean);
  expect((await request(server).get('/')).status).toBe(role ? 403 : 401);
  expect((await request(server).post('/').send({ purchase_id: purchase, mode: 'live' })).status).toBe(role ? 403 : 401);
  expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
test('list includes linked access accounts without changing state on GET', async () => {
  clientQuery.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{ ...pending, username: 'sim_fixture' }]});
  const result = await request(app('admin')).get('/');
  expect(result.status).toBe(200); expect(result.body[0].username).toBe('sim_fixture');
  expect(transaction).toHaveBeenCalledTimes(1);expect(clientQuery.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');expect(clientQuery.mock.calls[1][0]).toBe('SET LOCAL jit = off');expect(clientQuery.mock.calls[2][0]).toMatch(/^SELECT/);
});
test.each([{ purchase_id: 'bad', mode: 'live' }, { purchase_id: purchase, mode: 'simulation' }, { purchase_id: purchase, mode: 'invalid' }])('reject malformed or unconfirmed simulation %j', async (body) => {
  expect((await request(app('admin')).post('/').send(body)).status).toBe(400);
  expect(transaction).not.toHaveBeenCalled();
});
test('live unpaid preparation reserves one disabled account without starting time', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [{ id: purchase, payment_status: 'pending' }] })
    .mockResolvedValueOnce({ rows: [{ ...pending, mode: 'live', status: 'awaiting_payment' }] });
  const result = await request(app('admin')).post('/').send({ purchase_id: purchase, mode: 'live' });
  expect(result.status).toBe(201); expect(result.body.activation_at).toBeNull();
  expect(clientQuery.mock.calls[1][1][3]).toBe('awaiting_payment');
  expect(clientQuery.mock.calls[2][1][2]).toMatch(/^acct_/);
  expect(clientQuery.mock.calls.some((call) => call[0].includes('UPDATE billing_purchases'))).toBe(false);
});
test('replayed preparation returns same subscription without creating another account', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [{ id: purchase, payment_status: 'pending' }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [pending] });
  expect((await request(app('admin')).post('/').send({ purchase_id: purchase, mode: 'live' })).status).toBe(200);
  expect(clientQuery).toHaveBeenCalledTimes(3);
});
test('unknown purchase returns 404', async () => {
  expect((await request(app('admin')).post('/').send({ purchase_id: purchase, mode: 'live' })).status).toBe(404);
});
test('retired activation cannot create or change access',async()=>{
  expect((await request(app('admin')).post('/'+id+'/activate-simulation').send({confirm_simulation:true})).status).toBe(410);
  expect(transaction).not.toHaveBeenCalled();
});
test('explicit simulation preparation is rejected even with consent',async()=>{
  expect((await request(app('admin')).post('/').send({purchase_id:purchase,mode:'simulation',confirm_simulation:true})).status).toBe(400);
  expect(transaction).not.toHaveBeenCalled();
});

test('expiry touches only due active simulations and records its outcome', async () => {
  jest.mocked(query).mockResolvedValueOnce([{ customer_id: 1 }]);
  clientQuery.mockResolvedValueOnce({ rows: [{ id }] });
  expect(await expireSimulations()).toBe(1);
  expect(clientQuery.mock.calls[0][0]).toContain("mode='simulation' AND status='active'");
  expect(clientQuery.mock.calls[1][1]).toEqual([[id]]);
  expect(clientQuery.mock.calls[2][0]).toContain('simulation_expired');
});
test('no due simulations means no account changes', async () => {
  jest.mocked(query).mockResolvedValueOnce([]);
  expect(await expireSimulations()).toBe(0); expect(clientQuery).not.toHaveBeenCalled();
});
test('UUID validation is strict', () => {
  expect(uuid(id)).toBe(true); expect(uuid(`${id}suffix`)).toBe(false); expect(uuid(null)).toBe(false);
});
