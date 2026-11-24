import { query, transaction } from '../../config/database';
import { AccessError, versionNumber } from './accessPolicy';

export const PORTALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_portals (
  id SERIAL PRIMARY KEY,name VARCHAR(100) NOT NULL,slug VARCHAR(64) NOT NULL UNIQUE,
  draft_config JSONB NOT NULL,published_config JSONB,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  published_version INTEGER,published_at TIMESTAMPTZ,actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 64),
  CHECK((published_config IS NULL AND published_version IS NULL AND published_at IS NULL) OR
    (published_config IS NOT NULL AND published_version IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS billing_portal_events (
  id BIGSERIAL PRIMARY KEY,portal_id INTEGER NOT NULL REFERENCES billing_portals(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('created','saved','published','unpublished')),version INTEGER NOT NULL,
  actor TEXT NOT NULL,config_snapshot JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_portal_events_portal_idx ON billing_portal_events(portal_id,id DESC);
`;
export interface PortalConfig {
  template: 'classic' | 'split' | 'minimal'; brand_name: string; headline: string; welcome_text: string;
  primary_color: string; background_color: string; logo_data_url: string | null;
  support_phone: string; support_label: string; terms_text: string; footer_text: string;
  show_packages: boolean; package_ids: number[];
  package_display: { name: boolean; price: boolean; duration: boolean; download_speed: boolean; upload_speed: boolean; data_allowance: boolean };
}
const defaultPackageDisplay = { name: true,price: true,duration: true,download_speed: true,upload_speed: false,data_allowance: true };
const base: PortalConfig = { template: 'classic',brand_name: 'Your Wi-Fi',headline: 'Choose your connection.',
  welcome_text: '',primary_color: '#166534',background_color: '#f1f5f2',
  logo_data_url: null,support_phone: '',support_label: 'Support',terms_text: '',footer_text: '',show_packages: true,package_ids: [],package_display: defaultPackageDisplay };
export const portalTemplates = [
  { id: 'classic',name: 'Classic',description: 'A welcoming header with clear package cards.',default_config: base },
  { id: 'split',name: 'Spotlight',description: 'A bold brand panel beside your connection options.',default_config: { ...base,template: 'split',primary_color: '#1e40af',background_color: '#eff4ff' } },
  { id: 'minimal',name: 'Essential',description: 'A compact, simple layout for a quick visit.',default_config: { ...base,template: 'minimal',primary_color: '#7c2d12',background_color: '#faf5ef' } },
];
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError(400,'Portal details are required');
  return value as Record<string,unknown>;
}
function only(b: Record<string,unknown>,keys: string[]) {
  if (Object.keys(b).some((key) => !keys.includes(key))) throw new AccessError(400,'Unsupported portal field');
}
function text(value: unknown,label: string,max: number,required = false): string {
  if (typeof value !== 'string' || value.length>max || (required && !value.trim())) throw new AccessError(400,`${label} must be ${required ? 'between 1 and' : 'at most'} ${max} characters`);
  return value.trim();
}
export function portalSlug(value: unknown): string {
  if (typeof value !== 'string' || value.length<3 || value.length>64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) throw new AccessError(400,'Use a URL name of 3–64 lowercase letters, numbers and single hyphens');
  return value;
}
function logo(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length>262200) throw new AccessError(400,'Choose a PNG, JPEG or WebP logo up to 192 KB');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new AccessError(400,'Choose a PNG, JPEG or WebP logo');
  const bytes = Buffer.from(match[2],'base64');
  if (bytes.length>196608 || bytes.toString('base64') !== match[2]) throw new AccessError(400,'Logo is too large or invalid');
  const png = bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length>=4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length>=16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!((match[1] === 'png' && png) || (match[1] === 'jpeg' && jpeg) || (match[1] === 'webp' && webp))) throw new AccessError(400,'Logo contents do not match the image format');
  return value;
}
export function parsePortalConfig(value: unknown): PortalConfig {
  const b = object(value); only(b,Object.keys(base));
  if (!['classic','split','minimal'].includes(String(b.template))) throw new AccessError(400,'Choose a supported portal template');
  if (typeof b.primary_color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.primary_color) || typeof b.background_color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.background_color)) throw new AccessError(400,'Use six-digit hex colors');
  if (typeof b.show_packages !== 'boolean' || !Array.isArray(b.package_ids) || b.package_ids.length>24 || b.package_ids.some((id) => !Number.isInteger(id) || id<1 || id>2147483647)) throw new AccessError(400,'Choose up to 24 packages');
  const phone = text(b.support_phone,'Support phone',30);
  if (phone && (!/^\+?[0-9 ()-]{7,30}$/.test(phone) || phone.replace(/\D/g,'').length<7 || phone.replace(/\D/g,'').length>15)) throw new AccessError(400,'Enter a valid support phone number');
  // Older drafts and published snapshots keep the original visible fields.
  const display: Record<string,unknown> = b.package_display === undefined ? defaultPackageDisplay : object(b.package_display);
  only(display,Object.keys(defaultPackageDisplay));
  if (Object.keys(defaultPackageDisplay).some((key) => typeof display[key] !== 'boolean') || !Object.values(display).some((value) => value === true)) throw new AccessError(400,'Choose at least one package detail to display');
  return { template: b.template as PortalConfig['template'],brand_name: text(b.brand_name,'Brand name',100,true),
    headline: text(b.headline,'Welcome heading',120,true),welcome_text: text(b.welcome_text,'Welcome message',500),
    primary_color: b.primary_color.toLowerCase(),background_color: b.background_color.toLowerCase(),logo_data_url: logo(b.logo_data_url),
    support_phone: phone,support_label: text(b.support_label,'Support label',100),terms_text: text(b.terms_text,'Terms',2000),footer_text: text(b.footer_text,'Footer',160),
    show_packages: b.show_packages,package_ids: [...new Set(b.package_ids as number[])],package_display: { ...display } as PortalConfig['package_display'] };
}
export function parsePortalCreate(value: unknown) {
  const b = object(value); only(b,['name','slug','config']);
  return { name: text(b.name,'Portal name',100,true),slug: portalSlug(b.slug),config: parsePortalConfig(b.config) };
}
export function parsePortalSave(value: unknown) {
  const b = object(value); only(b,['name','version','config']);
  const version = versionNumber(b.version); if (version<1) throw new AccessError(400,'Refresh the portal before saving');
  return { name: text(b.name,'Portal name',100,true),version,config: parsePortalConfig(b.config) };
}
export function parsePortalVersion(value: unknown): number {
  const b = object(value); only(b,['version']);
  const version = versionNumber(b.version); if (version<1) throw new AccessError(400,'Refresh the portal before publishing');
  return version;
}
export async function portalList() {
  return query(`SELECT id,name,slug,version,draft_config->>'template' AS template,published_version,published_at,updated_at,actor,
    published_config IS NOT NULL AS published,draft_config IS DISTINCT FROM published_config AS has_unpublished_changes
    FROM billing_portals ORDER BY updated_at DESC,id`);
}
export async function portalDetail(id: number) {
  const row = (await query('SELECT *,draft_config IS DISTINCT FROM published_config AS has_unpublished_changes FROM billing_portals WHERE id=$1',[id]))[0];
  if (!row) throw new AccessError(404,'Portal not found');
  const history = await query('SELECT id,kind,version,actor,created_at FROM billing_portal_events WHERE portal_id=$1 ORDER BY id DESC LIMIT 30',[id]);
  return { ...row,history };
}
export async function createPortal(input: ReturnType<typeof parsePortalCreate>,actor: string) {
  const id = await transaction(async (client) => {
    const packages = (await client.query("SELECT id FROM billing_packages WHERE id=ANY($1::int[]) AND service_types @> ARRAY['hotspot']::text[]",[input.config.package_ids])).rows;
    if (packages.length !== input.config.package_ids.length) throw new AccessError(409,'Choose existing Hotspot-compatible packages');
    const row = (await client.query('INSERT INTO billing_portals(name,slug,draft_config,actor) VALUES($1,$2,$3,$4) RETURNING id',[input.name,input.slug,JSON.stringify(input.config),actor])).rows[0];
    await client.query("INSERT INTO billing_portal_events(portal_id,kind,version,actor) VALUES($1,'created',1,$2)",[row.id,actor]);
    return row.id as number;
  });
  return portalDetail(id);
}
export async function savePortal(id: number,input: ReturnType<typeof parsePortalSave>,actor: string) {
  await transaction(async (client) => {
    const row = (await client.query('SELECT version FROM billing_portals WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!row) throw new AccessError(404,'Portal not found');
    if (row.version !== input.version) throw new AccessError(409,'Portal changed. Refresh before saving your draft.');
    const ids = (await client.query("SELECT id FROM billing_packages WHERE id=ANY($1::int[]) AND service_types @> ARRAY['hotspot']::text[]",[input.config.package_ids])).rows;
    if (ids.length !== input.config.package_ids.length) throw new AccessError(409,'Choose existing Hotspot-compatible packages');
    await client.query('UPDATE billing_portals SET name=$2,draft_config=$3,actor=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[id,input.name,JSON.stringify(input.config),actor]);
    await client.query("INSERT INTO billing_portal_events(portal_id,kind,version,actor) VALUES($1,'saved',$2,$3)",[id,input.version+1,actor]);
  });
  return portalDetail(id);
}
export async function publishPortal(id: number,version: number,publish: boolean,actor: string) {
  await transaction(async (client) => {
    const row = (await client.query('SELECT * FROM billing_portals WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!row) throw new AccessError(404,'Portal not found');
    if (row.version !== version) throw new AccessError(409,'Portal changed. Refresh before changing publication.');
    const config = parsePortalConfig(row.draft_config);
    if (publish && config.show_packages) {
      const enabled = (await client.query("SELECT id FROM billing_packages WHERE id=ANY($1::int[]) AND enabled AND service_types @> ARRAY['hotspot']::text[] FOR SHARE",[config.package_ids])).rows;
      if (!config.package_ids.length || enabled.length !== config.package_ids.length) throw new AccessError(409,'Choose enabled Hotspot-compatible packages or hide the package catalog before publishing');
    }
    await client.query(`UPDATE billing_portals SET published_config=CASE WHEN $2 THEN draft_config ELSE NULL END,
      published_version=CASE WHEN $2 THEN version ELSE NULL END,published_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
      version=version+1,actor=$3,updated_at=clock_timestamp() WHERE id=$1`,[id,publish,actor]);
    await client.query('INSERT INTO billing_portal_events(portal_id,kind,version,actor,config_snapshot) VALUES($1,$2,$3,$4,$5)',
      [id,publish ? 'published' : 'unpublished',version+1,actor,publish ? JSON.stringify(config) : null]);
  });
  return portalDetail(id);
}
export async function publicPortal(slug: string) {
  const portal = (await query<{ published_config: PortalConfig; published_version: number }>('SELECT published_config,published_version FROM billing_portals WHERE slug=$1 AND published_config IS NOT NULL',[portalSlug(slug)]))[0];
  if (!portal) throw new AccessError(404,'This portal is not available');
  const config = parsePortalConfig(portal.published_config);
  const packages = config.show_packages ? await query(`SELECT id,name,amount_minor,currency,duration_value,duration_unit,
    download_bps::float8,upload_bps::float8,allowance_bytes::float8,fup_policy,version FROM billing_packages WHERE id=ANY($1::int[]) AND enabled AND service_types @> ARRAY['hotspot']::text[]
    ORDER BY array_position($1::int[],id)`,[config.package_ids]) : [];
  return { config,packages,version: portal.published_version,connection_available: false };
}
