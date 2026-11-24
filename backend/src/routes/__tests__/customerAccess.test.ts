jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingCustomers';
import { query, transaction } from '../../config/database';
import { parseGrant, parseOverride } from '../../modules/billing/customerAccess';

const key = 'f9a5949c-cd35-47da-955b-2df4ee4c342a';
const grant = { package_id: 1,package_version: 1,reason: ' Staff access ',mode: 'live',request_key: key,confirm_complimentary: true };
const override = { download_bps: 20000000,upload_bps: 5000000,reason: ' Support adjustment ',version: 0 };
function app(role?: string, scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { if (role) req.user = { userId: 1, username: 'fixture', role, ...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/',routes); return server;
}
beforeEach(() => { jest.resetAllMocks(); });
test.each([['viewer',false],['operator',false],['admin',true],[undefined,false]])('protect customer profile and controls from %s scoped=%s', async (role,scoped) => {
  const server = app(role as string | undefined,scoped as boolean);
  expect((await request(server).get('/1')).status).toBe(role ? 403 : 401);
  expect((await request(server).get('/1/fup')).status).toBe(role ? 403 : 401);
  expect((await request(server).put('/1/fup').send({mode:'exempt',version:0,reason:'Test'})).status).toBe(role ? 403 : 401);
  expect((await request(server).put('/1/speed-override').send(override)).status).toBe(role ? 403 : 401);
  expect((await request(server).post('/1/complimentary-access').send(grant)).status).toBe(role ? 403 : 401);
  expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
test('complimentary input keeps authorization separate from payment', () => {
  expect(parseGrant(grant,7)).toEqual({ customer_id: 7,package_id: 1,package_version: 1,reason: 'Staff access',mode: 'live',request_key: key });
});
test.each([
  { confirm_complimentary: false },{ confirm_complimentary: 'true' },{ mode: 'simulation' },{ mode: 'free' },{ package_id: 0 },{ package_version: '1' },
  { reason: '' },{ reason: 'x'.repeat(501) },{ request_key: 'bad' },{ payment_status: 'paid' },{ amount_minor: 0 },{ activation_at: '2026-01-01' },
])('reject invalid or forged complimentary grant %j', (changes) => {
  expect(() => parseGrant({ ...grant,...changes },1)).toThrow();
});
test('complimentary access defaults to normal preparation without a mode choice', () => {
  const {mode:_mode,...normal}=grant;void _mode;expect(parseGrant(normal,1).mode).toBe('live');
});
test('speed policy permits positive integer speeds and an explicit reset', () => {
  expect(parseOverride(override)).toMatchObject({ download_bps: 20000000,reason: 'Support adjustment',version: 0 });
  expect(parseOverride({ ...override,download_bps: null,upload_bps: null })).toMatchObject({ download_bps: null,upload_bps: null });
});
test.each([
  { download_bps: null },{ upload_bps: null },{ download_bps: 0 },{ upload_bps: -1 },{ download_bps: 1.5 },{ upload_bps: 1e12+1 },
  { version: -1 },{ version: '0' },{ version: 2147483647 },{ reason: '' },{ applied: true },{ package_id: 1 },
])('reject invalid or forged speed settings %j', (changes) => {
  expect(() => parseOverride({ ...override,...changes })).toThrow();
});
test('unknown profile returns 404', async () => {
  jest.mocked(query).mockResolvedValueOnce([]);
  expect((await request(app('admin')).get('/999')).status).toBe(404);
});
test('reject invalid customer ID before querying or writing', async () => {
  expect((await request(app('admin')).get('/bad')).status).toBe(400);
  expect((await request(app('admin')).put('/bad/speed-override').send(override)).status).toBe(400);
  expect((await request(app('admin')).post('/bad/complimentary-access').send(grant)).status).toBe(400);
  expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
});

test('complimentary access rejects retired simulation mode even with confirmation',()=>{expect(()=>parseGrant({...grant,mode:'simulation',confirm_simulation:true},7)).toThrow();});
