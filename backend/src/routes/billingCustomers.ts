import { customerFup,saveCustomerFup } from '../modules/billing/fupSettings';
import { addCustomerDevice, managementEvent } from '../modules/billing/accessManagement';
import { AccessError, macAddress } from '../modules/billing/accessPolicy';
import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { customerInput } from '../modules/billing/customersPayments';
import { positiveId } from '../modules/billing/packages';
import { customerProfile, saveOverride, parseOverride, grantComplimentary, parseGrant, CustomerAccessError } from '../modules/billing/customerAccess';

const router = Router();
// Personal/payment information is fleet-admin only until financial permissions exist.
router.use(requireAuth, requireAdmin);
router.get('/', async (_req: Request, res: Response) => {
  res.json(await query(`SELECT c.*, (SELECT count(*)::int FROM billing_purchases p WHERE p.customer_id=c.id) AS payment_count
    FROM billing_customers c ORDER BY lower(c.full_name), c.id`));
});
router.get('/:id/fup',async(req,res)=>{const id=positiveId(req.params.id);if(!id){res.status(400).json({error:'Invalid customer ID'});return;}if(!(await queryOne('SELECT id FROM billing_customers WHERE id=$1',[id]))){res.status(404).json({error:'Customer not found'});return;}res.json(await customerFup(id));});
router.put('/:id/fup',async(req,res)=>{const id=positiveId(req.params.id);if(!id){res.status(400).json({error:'Invalid customer ID'});return;}try{res.json(await saveCustomerFup(id,req.body,req.user!.username));}catch(e){if(e instanceof AccessError)res.status(e.status).json({error:e.message});else throw e;}});
router.get('/:id', async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid customer ID' }); return; }
  try { res.json(await customerProfile(id)); }
  catch (e) { if (e instanceof CustomerAccessError || e instanceof AccessError) res.status(e.status).json({ error: e.message }); else throw e; }
});
router.put('/:id/speed-override', async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid customer ID' }); return; }
  try { res.json(await saveOverride(id,parseOverride(req.body),req.user!.username)); }
  catch (e) { if (e instanceof CustomerAccessError || e instanceof AccessError) res.status(e.status).json({ error: e.message }); else throw e; }
});
router.post('/:id/complimentary-access', async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid customer ID' }); return; }
  try {
    const result = await grantComplimentary(parseGrant(req.body,id),req.user!.username);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (e) { if (e instanceof CustomerAccessError || e instanceof AccessError) res.status(e.status).json({ error: e.message }); else throw e; }
});
router.post('/', async (req: Request, res: Response) => {
  let p;
  try { p = customerInput(req.body); } catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  try {
    const mac = req.body.first_device_mac ? macAddress(req.body.first_device_mac) : null;
    const label = req.body.first_device_label || 'Primary device';
    if (mac && (typeof label !== 'string' || !label.trim() || label.trim().length>100)) throw new AccessError(400,'Enter a device label up to 100 characters');
    const sql = 'INSERT INTO billing_customers(full_name,phone,notes) VALUES($1,$2,$3) RETURNING *';
    const values = [p.full_name,p.phone,p.notes];
    const customer = mac ? await transaction(async (client) => {
      const row = (await client.query(sql,values)).rows[0];
      const device = await addCustomerDevice(client,row.id,label.trim(),mac,req.user!.username);
      await managementEvent(client,row.id,'device_registered',req.user!.username,'Registered during customer creation',{ device_id: device.id });
      return row;
    }) : await queryOne(sql,values);
    res.status(201).json(customer);
  } catch (e) {
    if (e instanceof AccessError) res.status(e.status).json({ error: e.message });
    else if ((e as { code?: string }).code === '23505') res.status(409).json({ error: 'This MAC address is already registered' });
    else throw e;
  }
});
router.put('/:id', async (req: Request, res: Response) => {
  const id = positiveId(req.params.id);
  const version = req.body?.version;
  if (!id || !Number.isInteger(version) || version < 1 || version >= 2147483647) {
    res.status(400).json({ error: 'A valid customer ID and version are required' }); return;
  }
  let p;
  try { p = customerInput(req.body); } catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  const customer = await queryOne(`UPDATE billing_customers SET full_name=$1,phone=$2,notes=$3,
    version=version+1,updated_at=now() WHERE id=$4 AND version=$5 RETURNING *`, [p.full_name,p.phone,p.notes,id,version]);
  if (!customer) {
    const exists = await queryOne('SELECT id FROM billing_customers WHERE id=$1', [id]);
    res.status(exists ? 409 : 404).json({ error: exists ? 'Customer changed. Reopen the record before saving.' : 'Customer not found' }); return;
  }
  res.json(customer);
});
export default router;
