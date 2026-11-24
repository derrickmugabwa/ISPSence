jest.mock('../../config/database');
jest.mock('../../middleware/auth',() => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown },res: { status: (n: number) => { json: (b: unknown) => void } },next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import bridge from '../radiusBridge';
import diagnostics from '../billingRadius';
import { parseRadiusAccounting } from '../../modules/billing/radiusAccounting';
import { transaction, query } from '../../config/database';
const a = (v: unknown) => ({ type: 'string',value: [v] });
const packet = { 'Tmp-IP-Address-0': a('127.0.0.1'),'User-Name': a('lab'),'Acct-Session-Id': a('fixture'),'Acct-Status-Type': a('Interim-Update'),'Acct-Input-Octets': a(10),'Acct-Output-Octets': a(20) };
const savedToken = process.env.RADIUS_BRIDGE_TOKEN;
beforeEach(() => { jest.resetAllMocks(); process.env.RADIUS_BRIDGE_TOKEN = 'a'.repeat(64); });
afterAll(() => { if (savedToken === undefined) delete process.env.RADIUS_BRIDGE_TOKEN; else process.env.RADIUS_BRIDGE_TOKEN = savedToken; });
const app = () => { const s = express(); s.use(express.json()); s.use('/',bridge); return s; };
test('unconfigured bridge fails closed',async () => {
  delete process.env.RADIUS_BRIDGE_TOKEN;
  expect((await request(app()).post('/accounting').send(packet)).status).toBe(503);
  expect(transaction).not.toHaveBeenCalled();
});
test.each([undefined,'Bearer bad','Bearer '+ 'b'.repeat(64)])('reject invalid bridge credential %s',async (token) => {
  const r = request(app()).post('/accounting'); if (token) r.set('Authorization',token);
  expect((await r.send(packet)).status).toBe(401); expect(transaction).not.toHaveBeenCalled();
});
test('even an authenticated bridge cannot admit a live account',async () => {
  expect((await request(app()).post('/authorize').set('Authorization','Bearer '+ 'a'.repeat(64)).send({ username: 'acct_customer' })).status).toBe(403);
  expect(transaction).not.toHaveBeenCalled();
});
test('gigawords combine exactly and NAS input maps to customer upload',() => {
  expect(parseRadiusAccounting({ ...packet,'Acct-Input-Gigawords': a(2),'Acct-Output-Gigawords': a(1) })).toMatchObject({ upload_bytes: 8589934602,download_bytes: 4294967316 });
});
test.each([1767225600,'Jan  1 2026 00:00:00 UTC','2026-01-01T00:00:00Z'])('decode numeric and FreeRADIUS date timestamp %s',(value) => {
  expect(parseRadiusAccounting({ ...packet,'Event-Timestamp': a(value) }).event_at).toBe('2026-01-01T00:00:00.000Z');
});
test('reject ambiguous local timestamps',() => {
  expect(() => parseRadiusAccounting({ ...packet,'Event-Timestamp': a('Jan 1 2026 00:00:00') })).toThrow();
});
test('non-accounting and sensitive attributes are not returned or persisted',() => {
  expect(parseRadiusAccounting({ ...packet,'User-Password': a('private'),'NAS-IP-Address': a('8.8.8.8') })).not.toHaveProperty('User-Password');
  expect(parseRadiusAccounting(packet).source_ip).toBe('127.0.0.1');
});
test.each([
  { 'Tmp-IP-Address-0': a('192.0.2.10') },{ 'Acct-Status-Type': a('Accept') },{ 'Acct-Input-Octets': a(-1) },
  { 'Acct-Input-Octets': a('1.5') },{ 'Acct-Input-Octets': a(4294967296) },{ 'Acct-Output-Gigawords': a(4294967295) },
  { 'User-Name': a('bad\nname') },{ 'User-Name': { value: ['one','two'] } },{ 'Acct-Session-Id': a('') },
  { 'Event-Timestamp': a(Math.floor(Date.now()/1000)+600) },
])('reject invalid or unenrolled accounting %j',(fields) => expect(() => parseRadiusAccounting({ ...packet,...fields })).toThrow());
test.each([[undefined,false],['viewer',false],['operator',false],['admin',true]])('restrict diagnostics for %s scoped=%s',async (role,scoped) => {
  const server = express();
  server.use((req,_res,next) => { if (role) req.user = { userId: 1,username: 'fixture',role: role as string,...(scoped ? { siteRoles: { 1: role as string } } : {}) }; next(); });
  server.use('/',diagnostics);
  expect((await request(server).get('/')).status).toBe(role ? 403 : 401); expect(query).not.toHaveBeenCalled();
});
