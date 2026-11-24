jest.mock('../../config/database');
jest.mock('../../middleware/rateLimitRedis',() => ({ rateLimitRedis: () => (_req: unknown,_res: unknown,next: () => void) => next() }));
jest.mock('../../middleware/auth',() => ({ ...jest.requireActual('../../middleware/auth'),requireAuth: (req: { user?: unknown },res: { status: (n: number) => { json: (v: unknown) => void } },next: () => void) => { if (!req.user) res.status(401).json({ error: 'Sign in required' }); else next(); } }));
import express from 'express';
import request from 'supertest';
import { payHeroAdminRoutes, payHeroCallbackRoutes, payHeroPublicRoutes } from '../payhero';
import { query, transaction } from '../../config/database';
function app(role?: string,scoped = false) { const a = express(); a.use(express.json()); a.use((req,_res,next) => { if (role) req.user = { userId: 1,username: 'fixture',role,...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); }); a.use('/admin',payHeroAdminRoutes); a.use('/callback',payHeroCallbackRoutes); a.use('/public',payHeroPublicRoutes); return a; }
beforeEach(() => jest.resetAllMocks());
test.each([[undefined,false],['viewer',false],['operator',false],['admin',true]])('PayHero management is restricted for %s scoped=%s',async (role,scoped) => {
  const a = request(app(role as string | undefined,scoped as boolean)), expected = role ? 403 : 401;
  for (const path of ['/admin/settings','/admin/payments/x']) expect((await a.get(path)).status).toBe(expected);
  expect((await a.put('/admin/settings').send({})).status).toBe(expected);
  for (const path of ['/admin/test','/admin/payments/x/collect','/admin/attempts/x/recheck','/admin/channels/list','/admin/banks/list','/admin/channels/bank']) expect((await a.post(path).send({})).status).toBe(expected);
  expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
});
test('public checkout status requires an unguessable capability',async () => { expect((await request(app()).get('/public/checkouts/00000000-0000-4000-8000-000000000000')).status).toBe(404); expect(query).not.toHaveBeenCalled(); });
test('callbacks without a valid scoped secret are rejected',async () => { expect((await request(app()).post('/callback/00000000-0000-4000-8000-000000000000/wrong').send({})).status).toBe(404); expect(transaction).not.toHaveBeenCalled(); });
test('unsupported callback methods cannot fall through to ordinary URL logging',async () => expect((await request(app()).get('/callback/some-id/some-secret')).status).toBe(404));
