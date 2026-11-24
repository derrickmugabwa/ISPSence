import api from './api';

export interface CustomerSession {
  id: string; account_id: string; source: 'simulation'|'radius'; quality?:string;freshness?:string; client_ip: string|null; client_mac: string|null; router_label: string;
  started_at: string; updated_at: string; ended_at: string | null; end_reason: 'test_stopped' | 'subscription_expired' | 'customer_suspended' | 'vacation' | 'complimentary_revoked' | 'schedule_closed' | 'device_disabled' | 'administrator_disconnect' | 'radius_stop' | null;
  download_bytes: number; upload_bytes: number; duration_seconds: number; username: string; subscription_id: string|null;
  subscription_expires_at: string|null; customer_id: number; customer_name: string; customer_code: string; payment_reference: string;
  funding: 'purchase' | 'complimentary' | 'unattributed';
}
export interface SessionEvent {
  request_key: string; kind: 'start' | 'update' | 'stop'; download_bytes: number; upload_bytes: number;
  reason: string | null; actor: string; recorded_at: string;
}
export interface StartSession {
  action: 'start'; account_id: string; client_ip: string; client_mac: string; router_label: string;
  request_key: string; confirm_simulation: boolean;
}
export interface ChangeSession {
  action: 'update' | 'stop'; download_bytes: number; upload_bytes: number; request_key: string; confirm_simulation: boolean;
}
export const sessionsApi = {
  list: (q: string, status: string, offset: number, customerId?: string) => api.get<{
    items: CustomerSession[]; summary: { total: number; active: number; download_bytes: number; upload_bytes: number }; offset: number; limit: number;
  }>('/billing/sessions', { params: { q, status, offset,customer_id: customerId } }).then((r) => r.data),
  detail: (id: string) => api.get<{ session: CustomerSession; events: SessionEvent[] }>(`/billing/sessions/${id}`).then((r) => r.data),
};
