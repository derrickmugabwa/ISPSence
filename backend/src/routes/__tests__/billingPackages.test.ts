jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; }
    next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingPackages';
import { query, queryOne } from '../../config/database';
import { parsePackage } from '../../modules/billing/packages';

const valid = { name: 'Daily', amount_minor: 5000, currency: 'KES', duration_value: 1,
  duration_unit: 'day', download_bps: 5000000, upload_bps: 2000000, allowance_bytes: null, enabled: true };
function app(role?: string, scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => {
    if (role) req.user = { userId: 1, username: 'fixture', role, ...(scoped ? { siteRoles: { 1: role } } : {}) };
    next();
  });
  server.use('/', routes);
  return server;
}
beforeEach(() => jest.clearAllMocks());

test('anonymous requests require login', async () => {
  expect((await request(app()).get('/')).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});
test('fleet viewer can list but neither viewer nor operator can change packages', async () => {
  jest.mocked(query).mockResolvedValueOnce([]);
  expect((await request(app('viewer')).get('/')).body).toEqual([]);
  for (const role of ['viewer','operator']) {
    expect((await request(app(role)).post('/').send(valid)).status).toBe(403);
    expect((await request(app(role)).put('/1').send({ ...valid, version: 1 })).status).toBe(403);
    expect((await request(app(role)).patch('/1/status').send({ enabled: false, version: 1 })).status).toBe(403);
  }
  expect(queryOne).not.toHaveBeenCalled();
});
test('site-scoped admin cannot read or mutate global package catalog', async () => {
  expect((await request(app('admin', true)).get('/')).status).toBe(403);
  expect((await request(app('admin', true)).post('/').send(valid)).status).toBe(403);
  expect(query).not.toHaveBeenCalled(); expect(queryOne).not.toHaveBeenCalled();
});
test('admin creates a normalized package with bound values', async () => {
  jest.mocked(queryOne).mockResolvedValueOnce({ id: 7, ...valid, version: 1 });
  const result = await request(app('admin')).post('/').send({ ...valid, name: ' Daily ' });
  expect(result.status).toBe(201);
  expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO billing_packages'),
    ['Daily', 5000, 1, 'day', 5000000, 2000000, null, true, null, null]);
});
test.each([
  { amount_minor: 0 }, { amount_minor: 1.5 }, { amount_minor: '5000' }, { name: ' ' },
  { duration_value: -1 }, { duration_unit: 'month' }, { duration_unit: ['hour'] }, { download_bps: 0 },
  { allowance_bytes: 0 }, { allowance_bytes: 'unlimited' }, { enabled: 'false' },
  { currency: 'USD' }, { upload_bps: 1e13 }, { name: 'x'.repeat(101) },
])('invalid fields rejected before any write: %j', async (fields) => {
  expect((await request(app('admin')).post('/').send({ ...valid, ...fields })).status).toBe(400);
  expect(queryOne).not.toHaveBeenCalled();
});
test('duplicate name is a useful conflict', async () => {
  jest.mocked(queryOne).mockRejectedValueOnce({ code: '23505' });
  const result = await request(app('admin')).post('/').send(valid);
  expect(result.status).toBe(409); expect(result.body.error).toContain('name');
});
test('stale edits return conflict and cannot overwrite a newer version', async () => {
  jest.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 1 });
  const result = await request(app('admin')).put('/1').send({ ...valid, version: 1 });
  expect(result.status).toBe(409);
  expect(jest.mocked(queryOne).mock.calls[0][0]).toContain('version=$10');
});
test('missing package returns not found', async () => {
  jest.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  expect((await request(app('admin')).put('/7').send({ ...valid, version: 1 })).status).toBe(404);
});
test('status changes are versioned and validated', async () => {
  jest.mocked(queryOne).mockResolvedValueOnce({ id: 1, enabled: false, version: 2 });
  expect((await request(app('admin')).patch('/1/status').send({ enabled: false, version: 1 })).status).toBe(200);
  expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('version=$3'), [false, 1, 1]);
  jest.clearAllMocks();
  expect((await request(app('admin')).patch('/1/status').send({ enabled: 'false', version: 2 })).status).toBe(400);
  expect((await request(app('admin')).put('/1').send(valid)).status).toBe(400);
  expect((await request(app('admin')).put('/1abc').send({ ...valid, version: 1 })).status).toBe(400);
  expect(queryOne).not.toHaveBeenCalled();
});
test('null is unlimited; calendar-month duration is preserved explicitly', () => {
  expect(parsePackage({ ...valid, duration_unit: 'calendar_month' })).toMatchObject({ allowance_bytes: null, duration_unit: 'calendar_month' });
});


test('service eligibility is normalized and omitted eligibility preserves existing settings',async () => {
  expect(parsePackage({ ...valid,service_types: ['pppoe','hotspot'] }).service_types).toEqual(['hotspot','pppoe']);
  jest.mocked(queryOne).mockResolvedValueOnce({ id: 1 });
  expect((await request(app('admin')).put('/1').send({ ...valid,version: 1 })).status).toBe(200);
  expect(jest.mocked(queryOne).mock.calls[0][0]).toContain('service_types=coalesce($11::text[],service_types)');
  expect(jest.mocked(queryOne).mock.calls[0][1]?.[10]).toBeNull();
});
test.each([[],['pppoe','pppoe'],['unknown'],null,'pppoe'])('invalid service eligibility is refused: %j',(service_types) => {
  expect(() => parsePackage({ ...valid,service_types })).toThrow();
});

test('package FUP settings are validated and explicit removal is distinguished from omission',async()=>{
 jest.mocked(queryOne).mockResolvedValue({id:1});
 await request(app('admin')).put('/1').send({...valid,version:1,fup_policy:null});
 expect(jest.mocked(queryOne).mock.calls[0][1]?.slice(-2)).toEqual([null,true]);
 jest.clearAllMocks();await request(app('admin')).put('/1').send({...valid,version:1});
 expect(jest.mocked(queryOne).mock.calls[0][1]?.slice(-2)).toEqual([null,false]);
 expect(()=>parsePackage({...valid,fup_policy:{tiers:[]}})).toThrow();
});
