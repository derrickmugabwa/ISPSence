jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import customerRoutes from '../billingCustomers';
import paymentRoutes from '../billingPayments';
import { query, queryOne, transaction } from '../../config/database';
import { customerInput, paymentInput, phoneNumber } from '../../modules/billing/customersPayments';

const clientQuery = jest.fn();
const key = 'b49a9931-ff87-4665-9917-373f6d454579';
const body = { customer_id: 5, package_id: 7, package_version: 1, payer_phone: '0712345678', request_key: key };
const record = { id: 'fixture', customer_id: 5, package_id: 7, payer_phone: '+254712345678', package_snapshot: { package_version: 1 } };
const offer = { id: 7, name: 'Daily', version: 1, enabled: true, amount_minor: 5000, currency: 'KES', duration_value: 1,
  duration_unit: 'day', download_bps: '5000000', upload_bps: '2000000', allowance_bytes: null };
function app(role?: string, scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { if (role) req.user = { userId: 1, username: 'fixture', role, ...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/customers', customerRoutes); server.use('/payments', paymentRoutes); return server;
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(transaction).mockImplementation((fn) => fn({ query: clientQuery } as never));
});
test.each([['viewer', false], ['operator', false], ['admin', true], [undefined, false]])('protect customer/payment data for %s scoped=%s', async (role, scoped) => {
  const status = role ? 403 : 401;
  for (const path of ['/customers','/payments']) {
    expect((await request(app(role as string | undefined, scoped as boolean)).get(path)).status).toBe(status);
    expect((await request(app(role as string | undefined, scoped as boolean)).post(path).send(body)).status).toBe(status);
  }
  expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
test('normalize contact numbers; do not require contact phone or conflate it with payer', () => {
  expect(phoneNumber('0712 345 678')).toBe('+254712345678');
  expect(phoneNumber('254112345678')).toBe('+254112345678');
  expect(customerInput({ full_name: ' Name ', phone: '', notes: ' note ' })).toEqual({ full_name: 'Name', phone: null, notes: 'note' });
  expect(paymentInput(body).payer_phone).toBe('+254712345678');
});
test.each([{ full_name: '' }, { full_name: 'x'.repeat(101) }, { full_name: 'Name', phone: 'bad' }, { full_name: 'Name', notes: 123 }, { full_name: 'Name',customer_code: 'CUS-999999' }])('reject invalid customer %j', async (input) => {
  expect((await request(app('admin')).post('/customers').send(input)).status).toBe(400);
  expect(queryOne).not.toHaveBeenCalled();
});
test('create customer and protect stale edits', async () => {
  jest.mocked(queryOne).mockResolvedValueOnce({ id: 5, full_name: 'Name' });
  expect((await request(app('admin')).post('/customers').send({ full_name: 'Name' })).status).toBe(201);
  jest.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 5 });
  expect((await request(app('admin')).put('/customers/5').send({ full_name: 'Changed', version: 1 })).status).toBe(409);
});
test.each([{ payment_status: 'paid' }, { access_status: 'active' }, { package_version: 0 }, { customer_id: '5' }, { request_key: 'bad' }, { payer_phone: '' }])('reject invalid payment or manual confirmation %j', async (change) => {
  expect((await request(app('admin')).post('/payments').send({ ...body, ...change })).status).toBe(400);
  expect(transaction).not.toHaveBeenCalled();
});
test('create pending payment using locked server package terms, not caller amount', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 5 }] })
    .mockResolvedValueOnce({ rows: [offer] }).mockResolvedValueOnce({ rows: [{ ...record, payment_status: 'pending', access_status: 'not_activated' }] });
  const result = await request(app('admin')).post('/payments').send({ ...body, amount_minor: 1 });
  expect(result.status).toBe(201); expect(result.body.payment_status).toBe('pending');
  expect(clientQuery.mock.calls[2][0]).toContain('FOR SHARE');
  const values = clientQuery.mock.calls[3][1];
  expect(values[6]).toBe(5000);
  expect(JSON.parse(values[8])).toMatchObject({ name: 'Daily', download_bps: 5000000, allowance_bytes: null, package_version: 1 });
});
test('replay existing request safely, even after offer changes', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [record] });
  expect((await request(app('admin')).post('/payments').send(body)).status).toBe(200);
  expect(clientQuery).toHaveBeenCalledTimes(1);
});
test('reject idempotency key reuse with different customer or payer', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [record] });
  expect((await request(app('admin')).post('/payments').send({ ...body, customer_id: 9 })).status).toBe(409);
});
test('concurrent insert conflict returns original record', async () => {
  clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 5 }] })
    .mockResolvedValueOnce({ rows: [offer] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [record] });
  expect((await request(app('admin')).post('/payments').send(body)).status).toBe(200);
});
test.each([[false, 1, 422], [true, 2, 409]])('reject disabled or changed package enabled=%s version=%s', async (enabled, version, status) => {
  clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 5 }] })
    .mockResolvedValueOnce({ rows: [{ ...offer, enabled, version }] });
  expect((await request(app('admin')).post('/payments').send(body)).status).toBe(status);
  expect(clientQuery).toHaveBeenCalledTimes(3);
});
test('validate and bind customer history filters', async () => {
  expect((await request(app('admin')).get('/payments?customer_id=5abc')).status).toBe(400);
  jest.mocked(query).mockResolvedValueOnce([]);
  expect((await request(app('admin')).get('/payments?customer_id=5')).status).toBe(200);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE p.customer_id=$1'), [5]);
});
