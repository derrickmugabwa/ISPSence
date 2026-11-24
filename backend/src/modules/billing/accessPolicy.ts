import type { PoolClient } from 'pg';

export class AccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const validUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function textReason(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length>500) throw new AccessError(400,'Enter a reason between 1 and 500 characters');
  return v.trim();
}
export function macAddress(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(v)) throw new AccessError(400,'Use a MAC address such as 02:00:00:00:00:01');
  const normalized = v.toLowerCase();
  if (normalized === '00:00:00:00:00:00' || normalized === 'ff:ff:ff:ff:ff:ff' || (parseInt(normalized.slice(0,2),16)&1)) throw new AccessError(400,'Use a unicast device MAC address');
  return normalized;
}
export function versionNumber(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v<0 || v>=2147483647) throw new AccessError(400,'A valid settings version is required');
  return v;
}
export interface ScheduleWindow { days: number[]; start: string; end: string }
export interface AccessSchedule { enabled: boolean; timezone: string; windows: ScheduleWindow[] }
const minutes = (s: string) => Number(s.slice(0,2))*60+Number(s.slice(3));
export function parseSchedule(v: unknown): AccessSchedule {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AccessError(400,'Schedule settings are required');
  const b = v as Record<string,unknown>;
  if (typeof b.enabled !== 'boolean' || typeof b.timezone !== 'string' || b.timezone.length>100 || !Array.isArray(b.windows) || b.windows.length>14) throw new AccessError(400,'Choose a timezone and up to 14 access windows');
  try { new Intl.DateTimeFormat('en-US',{ timeZone: b.timezone }).format(); } catch { throw new AccessError(400,'Choose a valid IANA timezone'); }
  const windows = b.windows.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new AccessError(400,'Invalid access window');
    const w = raw as Record<string,unknown>;
    if (!Array.isArray(w.days) || !w.days.length || w.days.some((d) => !Number.isInteger(d) || d<0 || d>6) || typeof w.start !== 'string' || typeof w.end !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end) || w.start === w.end) throw new AccessError(400,'Each window needs days, start and end; equal times are not allowed');
    return { days: [...new Set(w.days as number[])].sort(),start: w.start,end: w.end };
  });
  if (b.enabled && !windows.length) throw new AccessError(400,'Add at least one access window');
  return { enabled: b.enabled,timezone: b.timezone,windows };
}
export function scheduleAllows(schedule: AccessSchedule | null | undefined, now = new Date()): boolean {
  if (!schedule?.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-US',{ timeZone: schedule.timezone,weekday: 'short',hour: '2-digit',minute: '2-digit',hourCycle: 'h23' }).formatToParts(now);
  const values = new Map(parts.map((p) => [p.type,p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(values.get('weekday') ?? '');
  const time = Number(values.get('hour'))*60+Number(values.get('minute'));
  return schedule.windows.some((w) => {
    const start = minutes(w.start), end = minutes(w.end);
    return start<end ? w.days.includes(day) && time>=start && time<end
      : (w.days.includes(day) && time>=start) || (w.days.includes((day+6)%7) && time<end);
  });
}

export const SUBSCRIPTION_CUSTOMER_JOIN = `LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id`;
export async function lockCustomer(client: PoolClient, id: number): Promise<void> {
  if (!(await client.query('SELECT id FROM billing_customers WHERE id=$1 FOR UPDATE',[id])).rows.length) throw new AccessError(404,'Customer not found');
}
export async function checkReadiness(client: PoolClient, subscriptionId: string, now: Date, renewal = false): Promise<void> {
  const row = (await client.query(`SELECT coalesce(c.desired_state,'enabled') AS desired_state,r.revoked_at,r.frozen_remaining_ms,pol.schedule
    FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN}
    LEFT JOIN billing_customer_controls c ON c.customer_id=coalesce(p.customer_id,g.customer_id)
    LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    LEFT JOIN billing_access_policy pol ON pol.customer_id=coalesce(p.customer_id,g.customer_id) WHERE s.id=$1`,[subscriptionId])).rows[0];
  if (!row) throw new AccessError(404,'Subscription not found');
  if (row.revoked_at) throw new AccessError(409,'Complimentary access has been revoked');
  if (row.desired_state !== 'enabled') throw new AccessError(409,`Customer access is ${row.desired_state}`);
  if (row.frozen_remaining_ms !== null && row.frozen_remaining_ms !== undefined) throw new AccessError(409,'Vacation resume is waiting for access readiness');
  if (!scheduleAllows(row.schedule,now)) throw new AccessError(409,'Outside this customer’s scheduled access hours');
  if (!renewal && (await client.query("SELECT predecessor_id FROM billing_renewals WHERE successor_id=$1 AND status IN ('queued','pending_live')",[subscriptionId])).rows.length) throw new AccessError(409,'This access period is queued for renewal and cannot be activated early');
}

export async function checkSessionAdmission(client: PoolClient, customerId: number, mac: string): Promise<void> {
  const policy = (await client.query('SELECT max_sessions,registered_only FROM billing_access_policy WHERE customer_id=$1',[customerId])).rows[0];
  const device = (await client.query('SELECT enabled FROM billing_customer_devices WHERE customer_id=$1 AND mac=$2::macaddr',[customerId,mac])).rows[0];
  if (device?.enabled === false || (policy?.registered_only && !device?.enabled)) throw new AccessError(409,'This device is disabled or not registered for this customer');
  const active = (await client.query(`SELECT count(*)::int AS n FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id
    JOIN billing_subscriptions s ON s.id=a.subscription_id ${SUBSCRIPTION_CUSTOMER_JOIN}
    LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
    WHERE coalesce(p.customer_id,g.customer_id)=$1 AND x.ended_at IS NULL AND s.status='active' AND coalesce(r.effective_expires_at,s.expires_at)>clock_timestamp() AND r.frozen_remaining_ms IS NULL AND r.revoked_at IS NULL`,[customerId])).rows[0].n;
  if (active>=(policy?.max_sessions ?? 1)) throw new AccessError(409,'Customer simultaneous-session limit reached');
}

export async function lockSubscriptionCustomer(client: PoolClient, subscriptionId: string): Promise<void> {
  const owner = (await client.query(`SELECT coalesce(p.customer_id,g.customer_id) AS customer_id FROM billing_subscriptions s ${SUBSCRIPTION_CUSTOMER_JOIN} WHERE s.id=$1`,[subscriptionId])).rows[0];
  if (!owner) throw new AccessError(404,'Subscription not found');
  await lockCustomer(client,owner.customer_id);
}
