import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin, fleetOnly } from '../middleware/auth';
import { parsePackage, positiveId, PackageInput } from '../modules/billing/packages';

const router = Router();
router.use(requireAuth, fleetOnly);
// Explicit casts keep PostgreSQL bigint strings out of the browser's numeric fields.
const columns = `id, name, amount_minor, currency, duration_value, duration_unit,
  download_bps::float8 AS download_bps, upload_bps::float8 AS upload_bps,
  allowance_bytes::float8 AS allowance_bytes, fup_policy, service_types, enabled, version, created_at, updated_at`;
const values = (p: PackageInput) => [p.name, p.amount_minor, p.duration_value, p.duration_unit,
  p.download_bps, p.upload_bps, p.allowance_bytes, p.enabled];

function input(req: Request, res: Response): PackageInput | null {
  try { return parsePackage(req.body); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return null; }
}
function version(req: Request, res: Response): number | null {
  const v = req.body?.version;
  if (!Number.isInteger(v) || v < 1 || v >= 2147483647) {
    res.status(400).json({ error: 'A valid package version is required. Refresh and try again.' }); return null;
  }
  return v as number;
}
async function missingOrConflict(id: number, res: Response): Promise<void> {
  const exists = await queryOne('SELECT id FROM billing_packages WHERE id=$1', [id]);
  res.status(exists ? 409 : 404).json({ error: exists
    ? 'This package changed while you were editing. Reload it before saving.' : 'Package not found' });
}
function duplicate(error: unknown, res: Response): boolean {
  if ((error as { code?: string }).code !== '23505') return false;
  res.status(409).json({ error: 'A package with this name already exists.' }); return true;
}

router.get('/', async (_req: Request, res: Response) => {
  res.json(await query(`SELECT ${columns} FROM billing_packages ORDER BY lower(name), id`));
});

router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const p = input(req, res); if (!p) return;
  try {
    const result = await queryOne(`INSERT INTO billing_packages
      (name,amount_minor,duration_value,duration_unit,download_bps,upload_bps,allowance_bytes,enabled,service_types,fup_policy)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::text[],ARRAY['hotspot']::text[]),$10::jsonb) RETURNING ${columns}`, [...values(p),p.service_types ?? null,p.fup_policy?JSON.stringify(p.fup_policy):null]);
    res.status(201).json(result);
  } catch (error) { if (!duplicate(error, res)) throw error; }
});

router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid package ID' }); return; }
  const p = input(req, res); if (!p) return;
  const v = version(req, res); if (!v) return;
  try {
    const result = await queryOne(`UPDATE billing_packages SET name=$1, amount_minor=$2,
      duration_value=$3, duration_unit=$4, download_bps=$5, upload_bps=$6, allowance_bytes=$7,
      enabled=$8, service_types=coalesce($11::text[],service_types), fup_policy=CASE WHEN $13::boolean THEN $12::jsonb ELSE fup_policy END, version=version+1, updated_at=now() WHERE id=$9 AND version=$10 RETURNING ${columns}`,
    [...values(p), id, v, p.service_types ?? null,p.fup_policy?JSON.stringify(p.fup_policy):null,p.fup_policy!==undefined]);
    if (!result) { await missingOrConflict(id, res); return; }
    res.json(result);
  } catch (error) { if (!duplicate(error, res)) throw error; }
});

router.patch('/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid package ID' }); return; }
  if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Enabled must be true or false' }); return; }
  const v = version(req, res); if (!v) return;
  const result = await queryOne(`UPDATE billing_packages SET enabled=$1, version=version+1,
    updated_at=now() WHERE id=$2 AND version=$3 RETURNING ${columns}`, [req.body.enabled, id, v]);
  if (!result) { await missingOrConflict(id, res); return; }
  res.json(result);
});

export default router;
