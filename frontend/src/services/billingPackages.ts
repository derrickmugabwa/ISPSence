import type { FupPolicy } from './fup';
import api from './api';

export type ServiceType = 'hotspot' | 'pppoe';
export const packageSupports = (p: { service_types?: ServiceType[] },type: ServiceType) => (p.service_types ?? ['hotspot']).includes(type);
export const serviceTypesLabel = (types?: ServiceType[]) => types?.length===2 ? 'Both' : types?.[0]==='pppoe' ? 'PPPoE' : 'Hotspot';

export interface PackageInput {
  service_types?: ServiceType[];
  fup_policy?: FupPolicy | null;
  name: string;
  amount_minor: number;
  currency: 'KES';
  duration_value: number;
  duration_unit: 'hour' | 'day' | 'week' | 'calendar_month';
  download_bps: number;
  upload_bps: number;
  allowance_bytes: number | null;
  enabled: boolean;
}
export interface BillingPackage extends PackageInput {
  id: number;
  version: number;
  created_at: string;
  updated_at: string;
}
export const packagesApi = {
  list: () => api.get<BillingPackage[]>('/billing/packages').then((r) => r.data),
  create: (body: PackageInput) => api.post<BillingPackage>('/billing/packages', body),
  update: (id: number, body: PackageInput & { version: number }) => api.put<BillingPackage>(`/billing/packages/${id}`, body),
  status: (p: BillingPackage) => api.patch<BillingPackage>(`/billing/packages/${p.id}/status`, { enabled: !p.enabled, version: p.version }),
};
