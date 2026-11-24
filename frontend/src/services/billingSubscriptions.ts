import api from './api';
import type { Payment } from './billing';

export interface Subscription {
  service_id?: string | null; service_type?: 'hotspot' | 'pppoe'; service_label?: string | null;
  desired_session_limit: number;
  original_expires_at: string | null; frozen_remaining_ms: number | null; revoked_at: string | null; access_state: string; desired_access_state: string; applied_access_state: string;
  account_id: string;
  id: string; purchase_id: string | null; grant_id: string | null; mode: 'live' | 'simulation';
  status: 'awaiting_payment' | 'pending_activation' | 'active' | 'expired';
  activation_at: string | null; expires_at: string | null; revision: number;
  payment_reference: string; payment_status: Payment['payment_status'] | null;
  funding: 'purchase' | 'complimentary'; grant_reason: string | null; granted_by: string | null;
  desired_download_bps: number; desired_upload_bps: number; speed_override: boolean; speed_enforcement: 'not_applied';
  package_snapshot: Payment['package_snapshot']; customer_id: number; customer_name: string; customer_code: string;
  username: string; router_id: number | null; hotspot_name: string | null;
  account_state: 'planned' | 'simulated_ready' | 'simulated_expired'; credentials_issued: boolean; device_limit: number;
}
export interface SubscriptionInput { purchase_id: string }
export const subscriptionsApi = {
  list: (customerId?: string) => api.get<Subscription[]>('/billing/subscriptions', { params: customerId ? { customer_id: customerId } : {} }).then((r) => r.data),
  create: (body: SubscriptionInput) => api.post<Subscription>('/billing/subscriptions', body),
};
