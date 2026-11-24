import { linkPreparedService } from './serviceFunding';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../../config/database';
import { AccessError, lockCustomer, validUuid } from './accessPolicy';
import { asObject } from './payheroAdapter';
import { enqueueAccessJob } from './accessManagement';

export async function preparePaidAccess(client: PoolClient,purchase: { id: string; customer_id: number; service_id?: string | null },actor: string) {
  await client.query("UPDATE billing_purchases SET payment_status='paid',access_status='awaiting_activation' WHERE id=$1",[purchase.id]);
  const subscription = (await client.query(`INSERT INTO billing_subscriptions(id,purchase_id,mode,status) VALUES($1,$2,'live','pending_activation') ON CONFLICT(purchase_id,mode) DO UPDATE SET status='pending_activation' WHERE billing_subscriptions.status='awaiting_payment' RETURNING id`,[randomUUID(),purchase.id])).rows[0] ?? (await client.query("SELECT id FROM billing_subscriptions WHERE purchase_id=$1 AND mode='live'",[purchase.id])).rows[0];
  await client.query("INSERT INTO billing_access_accounts(id,subscription_id,username) VALUES($1,$2,$3) ON CONFLICT(subscription_id) DO NOTHING",[randomUUID(),subscription.id,`acct_${subscription.id.replace(/-/g,'')}`]);
  await linkPreparedService(client,subscription.id,purchase.service_id);
  await client.query("INSERT INTO billing_access_events(subscription_id,kind,actor) VALUES($1,'prepared',$2)",[subscription.id,actor]);
  await enqueueAccessJob(client,purchase.customer_id,'prepare',subscription.id,1,{ verified_payment_id: purchase.id },actor,'Payment confirmed; access readiness still required','pending',subscription.id);
}
export function manualReceiptInput(value: unknown) {
  const b = asObject(value), date = typeof b.paid_at === 'string' ? new Date(b.paid_at) : new Date(NaN);
  if (Object.keys(b).some((key) => !['request_key','method','reference','paid_at','notes','confirm_received'].includes(key)) || !validUuid(b.request_key) || !['cash','bank_transfer','manual_mpesa'].includes(String(b.method)) || typeof b.reference !== 'string' || b.reference.trim().length>160 || (b.method !== 'cash' && !b.reference.trim()) || typeof b.notes !== 'string' || !b.notes.trim() || b.notes.length>500 || b.confirm_received !== true || !Number.isFinite(date.getTime()) || date.getTime()>Date.now()+300000 || date.getTime()<Date.UTC(2000,0,1)) throw new AccessError(400,'Confirm receipt of payment, choose its method, and enter a valid payment time, reference and audit note');
  return { request_key: b.request_key,method: String(b.method),reference: b.method === 'manual_mpesa' ? b.reference.trim().toUpperCase() : b.reference.trim(),paid_at: date.toISOString(),notes: b.notes.trim() };
}
export async function recordManualReceipt(purchaseId: string,body: unknown,actor: string) {
  if (!validUuid(purchaseId)) throw new AccessError(400,'Invalid payment record');
  const b = manualReceiptInput(body), fingerprint = createHash('sha256').update(JSON.stringify([purchaseId,b])).digest('hex');
  try { return await transaction(async (client) => {
    const initial = (await client.query('SELECT * FROM billing_purchases WHERE id=$1',[purchaseId])).rows[0];
    if (!initial) throw new AccessError(404,'Payment record not found');
    await lockCustomer(client,initial.customer_id);
    const p = (await client.query('SELECT * FROM billing_purchases WHERE id=$1 FOR UPDATE',[purchaseId])).rows[0];
    const previous = (await client.query('SELECT * FROM billing_payment_receipts WHERE request_key=$1 OR purchase_id=$2',[b.request_key,purchaseId])).rows;
    if (previous.length) {
      const replay = previous.find((row) => row.fingerprint === fingerprint);
      if (replay) return { receipt: replay,replayed: true };
      throw new AccessError(409,'This payment or request already has a confirmed receipt');
    }
    if (['paid','refunded'].includes(p.payment_status)) throw new AccessError(409,'This payment record is already settled');
    if ((await client.query("SELECT 1 FROM billing_payhero_checkouts WHERE purchase_id=$1 AND mode='sandbox' UNION ALL SELECT 1 FROM billing_subscriptions WHERE purchase_id=$1 AND mode='simulation' UNION ALL SELECT 1 FROM billing_payhero_attempts WHERE purchase_id=$1 AND mode='sandbox' LIMIT 1",[purchaseId])).rows.length) throw new AccessError(409,'Create a separate payment record for a real payment. Test purchases cannot be converted to live receipts.');
    if ((await client.query("SELECT 1 FROM billing_payhero_attempts WHERE purchase_id=$1 AND mode='live' AND state<>'failed' LIMIT 1",[purchaseId])).rows.length) throw new AccessError(409,'Resolve the existing PayHero collection before recording an offline payment');
    const receipt = (await client.query(`INSERT INTO billing_payment_receipts(id,purchase_id,request_key,method,amount_minor,reference,paid_at,actor,notes,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),purchaseId,b.request_key,b.method,p.amount_minor,b.reference,b.paid_at,actor,b.notes,fingerprint])).rows[0];
    await preparePaidAccess(client,p,actor);
    await client.query("INSERT INTO billing_management_events(customer_id,kind,reason,actor,payload) VALUES($1,'manual_payment_recorded',$2,$3,$4)",[p.customer_id,b.notes,actor,JSON.stringify({ purchase_id: purchaseId,receipt_id: receipt.id,method: b.method })]);
    return { receipt,replayed: false };
  }); } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AccessError(409,'This receipt reference or payment was already recorded');
    throw e;
  }
}
