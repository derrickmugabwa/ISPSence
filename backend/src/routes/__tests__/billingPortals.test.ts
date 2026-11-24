jest.mock('../../config/database');
jest.mock('../../middleware/auth',() => ({
  ...jest.requireActual('../../middleware/auth'),
  requireAuth: (req: { user?: unknown },res: { status: (n: number) => { json: (b: unknown) => void } },next: () => void) => {
    if (!req.user) { res.status(401).json({ error: 'Sign in required' }); return; } next();
  },
}));
import express from 'express';
import request from 'supertest';
import routes, { publicPortalRoutes } from '../billingPortals';
import { parsePortalConfig, parsePortalCreate, parsePortalSave, parsePortalVersion, portalSlug, portalTemplates } from '../../modules/billing/portals';
import { query, transaction } from '../../config/database';
const config = portalTemplates[0].default_config;
function app(role?: string,scoped = false) {
  const server = express(); server.use(express.json());
  server.use((req,_res,next) => { if (role) req.user = { userId: 1,username: 'fixture',role,...(scoped ? { siteRoles: { 1: role } } : {}) }; next(); });
  server.use('/admin',routes); server.use('/public',publicPortalRoutes); return server;
}
beforeEach(() => jest.resetAllMocks());
test.each([[undefined,false],['viewer',false],['operator',false],['admin',true]])('restrict all portal administration for %s scoped=%s',async (role,scoped) => {
  const server = request(app(role as string | undefined,scoped as boolean));
  for (const path of ['/admin','/admin/templates','/admin/1']) expect((await server.get(path)).status).toBe(role ? 403 : 401);
  for (const path of ['/admin','/admin/1/publish','/admin/1/unpublish']) expect((await server.post(path).send({})).status).toBe(role ? 403 : 401);
  expect((await server.put('/admin/1').send({})).status).toBe(role ? 403 : 401);
  expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
test('fleet admin can discover all three template defaults',async () => {
  const r = await request(app('admin')).get('/admin/templates'); expect(r.status).toBe(200); expect(r.body).toHaveLength(3);
  for (const template of r.body) expect(() => parsePortalConfig(template.default_config)).not.toThrow();
});
test('unpublished portal is unavailable anonymously and never cached',async () => {
  jest.mocked(query).mockResolvedValueOnce([]);
  const r = await request(app()).get('/public/private-draft'); expect(r.status).toBe(404); expect(r.headers['cache-control']).toBe('no-store');
});
test('public response uses the published snapshot and a restricted package selection',async () => {
  jest.mocked(query).mockResolvedValueOnce([{ published_config: { ...config,package_ids: [7] },published_version: 3 }]).mockResolvedValueOnce([{ id: 7,name: 'Daily',amount_minor: 5000 }]);
  const r = await request(app()).get('/public/my-network'); expect(r.status).toBe(200); expect(r.body.config.brand_name).toBe(config.brand_name);
  expect(r.body.connection_available).toBe(false); expect(r.body).not.toHaveProperty('actor'); expect(r.body).not.toHaveProperty('draft_config');
  const sql = jest.mocked(query).mock.calls[1][0]; expect(sql).toContain('AND enabled'); expect(jest.mocked(query).mock.calls[1][1]).toEqual([[7]]);
});
test('hidden catalog does not query or expose package information',async () => {
  jest.mocked(query).mockResolvedValueOnce([{ published_config: { ...config,show_packages: false },published_version: 1 }]);
  const r = await request(app()).get('/public/my-network'); expect(r.status).toBe(200); expect(r.body.packages).toEqual([]); expect(query).toHaveBeenCalledTimes(1);
});
test.each(['ABCD','../admin','with space','-prefix','suffix-','double--dash','x','a'.repeat(65)])('reject invalid public slug %s',(value) => expect(() => portalSlug(value)).toThrow());
test.each([
  { template: 'custom-html' },{ primary_color: 'red' },{ primary_color: '#fff;background:url(javascript:alert(1))' },
  { background_color: '#12345' },{ support_phone: 'javascript:alert(1)' },{ support_phone: '()------' },
  { logo_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },{ logo_data_url: 'https://example.com/logo.png' },
  { logo_data_url: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' },{ logo_data_url: 'x'.repeat(262201) },
  { package_ids: [-1] },{ package_ids: ['1'] },{ package_ids: Array.from({ length: 25 },(_,i) => i+1) },
  { show_packages: 'true' },{ html: '<script>alert(1)</script>' },{ connection_available: true },
])('reject unsafe or unsupported portal configuration case %#',(fields) => expect(() => parsePortalConfig({ ...config,...fields })).toThrow());
test('logo PNG magic and safe base64 are accepted',() => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)]).toString('base64');
  expect(parsePortalConfig({ ...config,logo_data_url: `data:image/png;base64,${png}` }).logo_data_url).toContain('data:image/png');
});
test('deduplicate package IDs while retaining their display order',() => expect(parsePortalConfig({ ...config,package_ids: [3,1,3] }).package_ids).toEqual([3,1]));
test('older portal configs receive compatible package display defaults',() => {
  const { package_display: _display,...legacy } = config;
  void _display;
  expect(parsePortalConfig(legacy).package_display).toEqual({ name: true,price: true,duration: true,download_speed: true,upload_speed: false,data_allowance: true });
});
test('package display choices survive draft validation',() => {
  const display = { name: false,price: true,duration: false,download_speed: false,upload_speed: true,data_allowance: false };
  expect(parsePortalSave({ name: 'Main',version: 1,config: { ...config,package_display: display } }).config.package_display).toEqual(display);
});
test.each([null,[],{ price: true },{ ...config.package_display,price: 'yes' },{ ...config.package_display,html: true },{ name: false,price: false,duration: false,download_speed: false,upload_speed: false,data_allowance: false }])('reject invalid or empty package display configuration %#',(display) => {
  expect(() => parsePortalConfig({ ...config,package_display: display })).toThrow();
});
test.each([0,-1,1.5,'1',2147483647])('reject invalid editor version %s',(version) => expect(() => parsePortalSave({ name: 'Main',config,version })).toThrow());
test('publication cannot inject a different configuration or server-managed state',() => {
  expect(() => parsePortalVersion({ version: 1,config })).toThrow();
  expect(() => parsePortalCreate({ name: 'Main',slug: 'main',config,published_config: config })).toThrow();
});
