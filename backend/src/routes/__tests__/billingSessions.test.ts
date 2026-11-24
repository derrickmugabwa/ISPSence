jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingSessions';
import { query, transaction } from '../../config/database';
import { parseSessionCommand } from '../../modules/billing/sessions';

const id = 'f9a5949c-cd35-47da-955b-2df4ee4c342a';
const start = { action: 'start',account_id: id,client_ip: '192.0.2.10',client_mac: '02:AA:00:00:00:01',router_label: ' Test router ',request_key: id,confirm_simulation: true };
function app(role?: string, scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { if (role) req.user = { userId: 1, username: 'fixture', role, ...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/',routes); return server;
}
beforeEach(() => { jest.resetAllMocks();jest.mocked(transaction).mockImplementation(fn=>fn({query:async(sql:string,params:unknown[])=>({rows:sql.startsWith('SET ')?[]:await query(sql,params)})} as never)); });

test.each([['viewer',false],['operator',false],['admin',true],[undefined,false]])('protect session data and test controls for %s scoped=%s', async (role,scoped) => {
  const server = app(role as string | undefined,scoped as boolean);
  for (const [method,path] of [['get','/'],['get',`/${id}`],['post','/simulation'],['post',`/${id}/simulation`]] as const) {
    const call = method === 'get' ? request(server).get(path) : request(server).post(path);
    expect((await call.send(start)).status).toBe(role ? 403 : 401);
  }
  expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
});
test('normalize test identity and strip confirmation from the stored command', () => {
  expect(parseSessionCommand(start)).toEqual({ action: 'start',account_id: id,client_ip: '192.0.2.10',client_mac: '02:aa:00:00:00:01',router_label: 'Test router',request_key: id });
});
test('accept IPv6 client addresses', () => {
  expect(parseSessionCommand({ ...start,client_ip: '2001:db8::1' }).action).toBe('start');
});
test.each([
  { confirm_simulation: false },{ confirm_simulation: 'true' },{ request_key: 'bad' },{ account_id: 'bad' },
  { client_ip: 'router.local' },{ client_ip: '192.0.2.1/24' },{ client_mac: 'bad' },{ router_label: '' },
  { router_label: 'x'.repeat(101) },{ source: 'radius' },{ started_at: '2026-01-01' },{ router_id: 1 },{ action: 'stop' },
])('reject malformed, unconfirmed or server-owned fields %j', (fields) => {
  expect(() => parseSessionCommand({ ...start,...fields })).toThrow();
});
test.each([-1,0.5,Number.MAX_SAFE_INTEGER+1,'100',null])('reject invalid cumulative counter %s', (download_bytes) => {
  expect(() => parseSessionCommand({ action: 'update',download_bytes,upload_bytes: 0,request_key: id,confirm_simulation: true },id)).toThrow();
});
test('accept zero and large safe counters without rounding', () => {
  expect(parseSessionCommand({ action: 'stop',download_bytes: Number.MAX_SAFE_INTEGER,upload_bytes: 0,request_key: id,confirm_simulation: true },id)).toMatchObject({ action: 'stop',download_bytes: Number.MAX_SAFE_INTEGER,upload_bytes: 0 });
});
test.each(['?offset=-1','?offset=1.5','?status=online','?q='+ 'x'.repeat(101),'?q[]=bad'])('reject invalid list filters %s', async (suffix) => {
  expect((await request(app('admin')).get('/'+suffix)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
test('paginated list is read-only and searches literal wildcard input', async () => {
  jest.mocked(query).mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([{ total: 1,active: 1 }]);
  const result = await request(app('admin')).get('/?q=100%25_test&status=active&offset=50');
  expect(result.status).toBe(200); expect(result.body.items).toEqual([{ id }]); expect(result.body.offset).toBe(50);
  expect(jest.mocked(query).mock.calls[0][1]?.[0]).toBe('%100\\%\\_test%');
  expect(transaction).toHaveBeenCalledTimes(1);
});
test('unknown session returns 404', async () => {
  jest.mocked(query).mockResolvedValueOnce([]);
  expect((await request(app('admin')).get(`/${id}`)).status).toBe(404);
});
test('invalid session ID returns 400', async () => {
  expect((await request(app('admin')).get('/bad')).status).toBe(400); expect(query).not.toHaveBeenCalled();
});
test('retired simulation endpoint cannot write session data', async () => {
  expect((await request(app('admin')).post('/simulation').send({ ...start,confirm_simulation: true })).status).toBe(410);
  expect(transaction).not.toHaveBeenCalled();
});
