import api from './api';
import type { Customer } from './billing';

export interface NetworkSettings {
  customer_id: number; version: number; download_bps: number | null; upload_bps: number | null;
  reason: string | null; actor: string | null; updated_at: string | null;
}
export interface NetworkEvent {
  id: number; version: number; download_bps: number | null; upload_bps: number | null; reason: string; actor: string; created_at: string;
}
export interface ComplimentaryInput {
  service_id?: string;
  package_id: number; package_version: number; reason: string; request_key: string;
  confirm_complimentary: boolean;
}
export const customerProfileApi = {
  get: (id: string) => api.get<{ customer: Customer; network: NetworkSettings; network_history: NetworkEvent[]; enforcement: 'not_applied' }>(`/billing/customers/${id}`).then((r) => r.data),
  override: (id: string, body: { version: number; download_bps: number | null; upload_bps: number | null; reason: string }) => api.put<NetworkSettings>(`/billing/customers/${id}/speed-override`,body),
  complimentary: (id: string, body: ComplimentaryInput) => api.post<{ subscription_id: string }>(`/billing/customers/${id}/complimentary-access`,body),
};
