import { createHash, randomUUID } from 'crypto';
import { isIP } from 'net';
import { query, transaction } from '../../config/database';
import { AccessError } from './accessPolicy';

export const RADIUS_ACCOUNTING_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_radius_records (
  id UUID PRIMARY KEY,source_ip INET NOT NULL,nas_identifier VARCHAR(100) NOT NULL,
  username VARCHAR(100) NOT NULL,session_key VARCHAR(128) NOT NULL,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),last_received_at TIMESTAMPTZ NOT NULL,
  elapsed_seconds BIGINT NOT NULL CHECK(elapsed_seconds>=0),
  download_bytes BIGINT NOT NULL CHECK(download_bytes BETWEEN 0 AND 9007199254740991),
  upload_bytes BIGINT NOT NULL CHECK(upload_bytes BETWEEN 0 AND 9007199254740991),
  start_seen BOOLEAN NOT NULL DEFAULT false,stop_seen BOOLEAN NOT NULL DEFAULT false,
  ambiguous BOOLEAN NOT NULL DEFAULT false,lab BOOLEAN NOT NULL DEFAULT true CHECK(lab),
  UNIQUE(source_ip,nas_identifier,username,session_key)
);
CREATE TABLE IF NOT EXISTS billing_radius_packets (
  id BIGSERIAL PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,record_id UUID REFERENCES billing_radius_records(id) ON DELETE RESTRICT,
  source_ip INET NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('Start','Interim-Update','Stop','Accounting-On','Accounting-Off')),
  event_at TIMESTAMPTZ,elapsed_seconds BIGINT NOT NULL,download_bytes BIGINT NOT NULL,upload_bytes BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_radius_records_recent ON billing_radius_records(last_received_at DESC,id);
CREATE INDEX IF NOT EXISTS billing_radius_packets_recent ON billing_radius_packets(received_at DESC);
`;

const UINT32 = 4294967295;
type Attributes = Record<string,unknown>;
// rlm_rest's JSON encoder sends typed attributes with a single-value array.
function attribute(b: Attributes,name: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- Names are fixed parser constants.
  const entry = b[name];
  if (entry === undefined) return undefined;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new AccessError(400,'Invalid RADIUS attribute');
  const value = (entry as { value?: unknown }).value;
  if (!Array.isArray(value) || value.length !== 1) throw new AccessError(400,'RADIUS attributes must have one value');
  return value[0];
}
function text(b: Attributes,name: string,max: number,required = true): string {
  const v = attribute(b,name);
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || !v || v.length>max || Array.from(v).some((c) => c.charCodeAt(0)<32 || c.charCodeAt(0) === 127)) throw new AccessError(400,`Invalid ${name}`);
  return v;
}
function unsigned(b: Attributes,name: string,required = false): number {
  const v = attribute(b,name);
  if (v === undefined && !required) return 0;
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d{1,10}$/.test(String(v))) throw new AccessError(400,`Invalid ${name}`);
  const n = Number(v);
  if (!Number.isInteger(n) || n<0 || n>UINT32) throw new AccessError(400,`Invalid ${name}`);
  return n;
}
function octets(b: Attributes,direction: 'Input' | 'Output'): number {
  const n = BigInt(unsigned(b,`Acct-${direction}-Gigawords`))*4294967296n+BigInt(unsigned(b,`Acct-${direction}-Octets`));
  if (n>BigInt(Number.MAX_SAFE_INTEGER)) throw new AccessError(400,'Accounting counters exceed the supported exact range');
  return Number(n);
}
function eventTime(b: Attributes): string | null {
  const v = attribute(b,'Event-Timestamp');
  if (v === undefined) return null;
  let milliseconds: number;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    milliseconds = unsigned(b,'Event-Timestamp',true)*1000;
  } else if (typeof v === 'string' && v.length<=80 &&
    (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) ||
      /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+\d\d:\d\d:\d\d\s+(?:UTC|GMT|[+-]\d{4})$/.test(v))) {
    // FreeRADIUS 3 JSON encodes date attributes as timezone-qualified text.
    milliseconds = Date.parse(v);
  } else throw new AccessError(400,'Invalid Event-Timestamp');
  if (!Number.isFinite(milliseconds) || milliseconds<0 || milliseconds>Date.now()+300000) throw new AccessError(400,'Invalid accounting timestamp');
  return new Date(milliseconds).toISOString();
}
export function parseRadiusAccounting(body: unknown,enrolledSource = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400,'RADIUS attributes are required');
  const b = body as Attributes;
  const kind = text(b,'Acct-Status-Type',32);
  if (!['Start','Interim-Update','Stop','Accounting-On','Accounting-Off'].includes(kind)) throw new AccessError(400,'Unsupported accounting packet');
  // Set by FreeRADIUS from its UDP socket, never taken from NAS-IP-Address.
  const source_ip = text(b,'Tmp-IP-Address-0',45);
  if (!isIP(source_ip) || (!enrolledSource && source_ip !== '127.0.0.1')) throw new AccessError(403,'Only the private loopback RADIUS lab is enrolled');
  const boundary = kind === 'Accounting-On' || kind === 'Accounting-Off';
  const username = text(b,'User-Name',100,!boundary), session_key = text(b,'Acct-Session-Id',128,!boundary);
  return { kind,source_ip,nas_identifier: text(b,'NAS-Identifier',100,false),username,session_key,
    event_at: eventTime(b),elapsed_seconds: unsigned(b,'Acct-Session-Time'),
    // RADIUS input is traffic entering the NAS from the subscriber (upload).
    upload_bytes: octets(b,'Input'),download_bytes: octets(b,'Output') };
}

export async function receiveRadiusAccounting(packet: ReturnType<typeof parseRadiusAccounting>) {
  const fingerprint = createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  const scope = `${packet.source_ip}\n${packet.nas_identifier}\n${packet.username}\n${packet.session_key}`;
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[scope]);
    if ((await client.query('SELECT id FROM billing_radius_packets WHERE fingerprint=$1',[fingerprint])).rows.length) return { replayed: true };
    let recordId: string | null = null;
    if (packet.kind === 'Accounting-On' || packet.kind === 'Accounting-Off') {
      // Boot boundaries make an unlinked stream ambiguous. Never infer a new
      // customer's entitlement or reopen a stopped record from this evidence.
      await client.query('UPDATE billing_radius_records SET ambiguous=true WHERE source_ip=$1 AND NOT stop_seen',[packet.source_ip]);
    } else {
      const row = (await client.query(`INSERT INTO billing_radius_records(id,source_ip,nas_identifier,username,session_key,
        last_received_at,elapsed_seconds,download_bytes,upload_bytes,start_seen,stop_seen)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7,$8,$9,$10)
        ON CONFLICT(source_ip,nas_identifier,username,session_key) DO UPDATE SET
          ambiguous=billing_radius_records.ambiguous OR
            (EXCLUDED.start_seen AND (billing_radius_records.stop_seen OR billing_radius_records.elapsed_seconds>EXCLUDED.elapsed_seconds)),
          elapsed_seconds=greatest(billing_radius_records.elapsed_seconds,EXCLUDED.elapsed_seconds),
          download_bytes=greatest(billing_radius_records.download_bytes,EXCLUDED.download_bytes),
          upload_bytes=greatest(billing_radius_records.upload_bytes,EXCLUDED.upload_bytes),
          start_seen=billing_radius_records.start_seen OR EXCLUDED.start_seen,
          stop_seen=billing_radius_records.stop_seen OR EXCLUDED.stop_seen,last_received_at=clock_timestamp()
        RETURNING id`,[randomUUID(),packet.source_ip,packet.nas_identifier,packet.username,packet.session_key,
        packet.elapsed_seconds,packet.download_bytes,packet.upload_bytes,packet.kind === 'Start',packet.kind === 'Stop'])).rows[0];
      recordId = row.id;
    }
    await client.query(`INSERT INTO billing_radius_packets(fingerprint,record_id,source_ip,kind,event_at,elapsed_seconds,download_bytes,upload_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[fingerprint,recordId,packet.source_ip,packet.kind,packet.event_at,packet.elapsed_seconds,packet.download_bytes,packet.upload_bytes]);
    return { replayed: false };
  });
}
export async function radiusDiagnostics(offset: number) {
  const [summary,records] = await Promise.all([
    query(`SELECT count(*)::int AS packet_count,max(received_at) AS last_received_at FROM billing_radius_packets`),
    query(`SELECT *,host(source_ip) AS source_ip,elapsed_seconds::float8,download_bytes::float8,upload_bytes::float8
      FROM billing_radius_records ORDER BY last_received_at DESC,id LIMIT 50 OFFSET $1`,[offset]),
  ]);
  const total = (await query('SELECT count(*)::int AS total FROM billing_radius_records'))[0].total;
  return { configured: (process.env.RADIUS_BRIDGE_TOKEN?.length ?? 0)>=64,mode: 'private_lab',live_authorization: false,
    summary: summary[0],records,total,offset,limit: 50 };
}
