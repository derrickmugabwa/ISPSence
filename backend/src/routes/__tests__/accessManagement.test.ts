jest.mock('../../config/database');
jest.mock('../../middleware/auth',() => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown },res: { status: (n: number) => { json: (b: unknown) => void } },next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes from '../billingAccessManagement';
import { transaction, query } from '../../config/database';
import { parseSchedule, scheduleAllows, macAddress, versionNumber } from '../../modules/billing/accessPolicy';

function app(role?: string,scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req,_res,next) => { if (role) req.user = { userId: 1,username: 'fixture',role,...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/',routes); return server;
}
beforeEach(() => jest.resetAllMocks());
test.each([[undefined,false],['viewer',false],['operator',false],['admin',true]])('protect every access management operation for %s scoped=%s',async (role,scoped) => {
  for (const [method,path] of [['get','/alerts'],['get','/customers/1'],['post','/alerts/f9a5949c-cd35-47da-955b-2df4ee4c342a/read'],['post','/customers/1/devices'],['put','/customers/1/devices/f9a5949c-cd35-47da-955b-2df4ee4c342a'],['put','/customers/1/policy'],['post','/customers/1/control'],['post','/customers/1/revoke/f9a5949c-cd35-47da-955b-2df4ee4c342a'],['post','/customers/1/disconnect'],['post','/customers/1/renewal']] as const) {
    const server = request(app(role as string | undefined,scoped as boolean));
    expect((await server[method](path).send({})).status).toBe(role ? 403 : 401);
  }
  expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
test.each(['control','disconnect','devices','renewal'])('reject fabricated enforcement fields in %s before writes',async (path) => {
  expect((await request(app('admin')).post(`/customers/1/${path}`).send({ request_key: 'f9a5949c-cd35-47da-955b-2df4ee4c342a',reason: 'Test',status: 'applied' })).status).toBe(400);
  expect(transaction).not.toHaveBeenCalled();
});
test.each(['ff:ff:ff:ff:ff:ff','00:00:00:00:00:00','01:00:5e:00:00:01','02-00-00-00-00-01',null])('reject non-device MAC %s',(v) => expect(() => macAddress(v)).toThrow());
test('normalize unicast device MAC',() => expect(macAddress('02:AA:00:00:00:01')).toBe('02:aa:00:00:00:01'));
test.each([-1,1.5,'1',null,2147483647])('reject invalid version %s',(v) => expect(() => versionNumber(v)).toThrow());
const schedule = (days: number[],start: string,end: string,timezone = 'Africa/Nairobi') => parseSchedule({ enabled: true,timezone,windows: [{ days,start,end }] });
test('same-day local schedule includes start and excludes end',() => {
  const s = schedule([4],'08:00','18:00'); // Thursday
  expect(scheduleAllows(s,new Date('2026-10-15T04:59:59Z'))).toBe(false);
  expect(scheduleAllows(s,new Date('2026-10-15T05:00:00Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-10-15T14:59:59Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-10-15T15:00:00Z'))).toBe(false);
});
test('overnight Sunday schedule crosses into Monday and handles midnight',() => {
  const s = schedule([0],'22:00','02:00','UTC');
  expect(scheduleAllows(s,new Date('2026-10-18T21:59:59Z'))).toBe(false);
  expect(scheduleAllows(s,new Date('2026-10-18T22:00:00Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-10-19T00:00:00Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-10-19T01:59:59Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-10-19T02:00:00Z'))).toBe(false);
  expect(scheduleAllows(s,new Date('2026-10-20T01:00:00Z'))).toBe(false);
});
test('DST repeated hour follows wall-clock schedule on both occurrences',() => {
  const s = schedule([0],'01:00','02:00','America/New_York');
  expect(scheduleAllows(s,new Date('2026-11-01T05:30:00Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-11-01T06:30:00Z'))).toBe(true);
  expect(scheduleAllows(s,new Date('2026-11-01T07:00:00Z'))).toBe(false);
});
test('DST skipped hour creates no extra allowed time',() => {
  const s = schedule([0],'02:00','03:00','America/New_York');
  expect(scheduleAllows(s,new Date('2026-03-08T06:59:59Z'))).toBe(false);
  expect(scheduleAllows(s,new Date('2026-03-08T07:00:00Z'))).toBe(false);
});
test.each([
  { enabled: true,timezone: 'Mars',windows: [] },
  { enabled: true,timezone: 'UTC',windows: [] },
  { enabled: true,timezone: 'UTC',windows: [{ days: [1],start: '08:00',end: '08:00' }] },
  { enabled: true,timezone: 'UTC',windows: [{ days: [7],start: '08:00',end: '09:00' }] },
  { enabled: true,timezone: 'UTC',windows: [{ days: [1],start: '25:00',end: '09:00' }] },
])('reject invalid schedule %j',(v) => expect(() => parseSchedule(v)).toThrow());
