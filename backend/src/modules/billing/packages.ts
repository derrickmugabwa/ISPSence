import { parseFup,type FupPolicy } from './fup';
export const PACKAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_packages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
  duration_value INTEGER NOT NULL CHECK (duration_value BETWEEN 1 AND 10000),
  duration_unit TEXT NOT NULL CHECK (duration_unit IN ('hour','day','week','calendar_month')),
  download_bps BIGINT NOT NULL CHECK (download_bps BETWEEN 1 AND 1000000000000),
  upload_bps BIGINT NOT NULL CHECK (upload_bps BETWEEN 1 AND 1000000000000),
  allowance_bytes BIGINT CHECK (allowance_bytes BETWEEN 1 AND 1000000000000000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_packages_name_key ON billing_packages(lower(name));
`;

export interface PackageInput {
  name: string;
  amount_minor: number;
  duration_value: number;
  duration_unit: 'hour' | 'day' | 'week' | 'calendar_month';
  download_bps: number;
  upload_bps: number;
  allowance_bytes: number | null;
  enabled: boolean;
  service_types?: ('hotspot' | 'pppoe')[];
  fup_policy?: FupPolicy | null;
}

export function parsePackage(body: unknown): PackageInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Package details are required');
  const b = body as Record<string, unknown>;
  const integer = (v: unknown, max: number, label: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) {
      throw new Error(`${label} must be a positive whole number within the supported range`);
    }
    return v;
  };
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 100) {
    throw new Error('Package name must be between 1 and 100 characters');
  }
  if (typeof b.duration_unit !== 'string' || !['hour','day','week','calendar_month'].includes(b.duration_unit)) throw new Error('Choose a valid duration unit');
  if (typeof b.enabled !== 'boolean') throw new Error('Enabled must be true or false');
  if (b.currency !== undefined && b.currency !== 'KES') throw new Error('Only KES is supported');
  let serviceTypes: PackageInput['service_types'];
  if (b.service_types !== undefined) {
    if (!Array.isArray(b.service_types) || !b.service_types.length || b.service_types.length>2 || new Set(b.service_types).size!==b.service_types.length || b.service_types.some((v) => v!=='hotspot' && v!=='pppoe')) throw new Error('Choose Hotspot, PPPoE, or both');
    serviceTypes = ['hotspot','pppoe'].filter((v) => b.service_types instanceof Array && b.service_types.includes(v)) as PackageInput['service_types'];
  }
  return {
    ...(b.fup_policy!==undefined ? {fup_policy:parseFup(b.fup_policy)} : {}),
    ...(serviceTypes ? { service_types: serviceTypes } : {}),
    name: b.name.trim(), amount_minor: integer(b.amount_minor, 2147483647, 'Price in minor units'),
    duration_value: integer(b.duration_value, 10000, 'Duration'),
    duration_unit: b.duration_unit as PackageInput['duration_unit'],
    download_bps: integer(b.download_bps, 1e12, 'Download speed'),
    upload_bps: integer(b.upload_bps, 1e12, 'Upload speed'),
    allowance_bytes: b.allowance_bytes === null ? null : integer(b.allowance_bytes, 1e15, 'Data allowance'),
    enabled: b.enabled,
  };
}

export function positiveId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
