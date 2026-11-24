import api from './api';
export interface DashboardFilters { start: string; end: string; view: 'customers' | 'transactions'; q: string; status: string; method: string; package_id: number; offset: number }
export interface DashboardCustomer {
  id: number; full_name: string; customer_code: string; phone: string | null; subscription_id: string | null; package_snapshot: { name: string } | null;
  access_state: string; applied_state: string | null; desired_state: string | null; funding: string | null; connection: string; sessions: number;
  expires_at: string | null; frozen_remaining_ms: string | null; username: string | null; reference: string | null; latest_purchase_id: string | null;
  payment_status: string | null; payment_method: string | null; amount_minor: number | null; last_payment_at: string | null; last_seen: string | null; failed_jobs: number;
}
export interface DashboardTransaction {
  id: string; reference: string; customer_id: number; customer_name: string; customer_code: string; customer_phone: string | null; payer_phone: string;
  package_name: string; amount_minor: number; result: string; access_status: string; payment_method: string; activity_at: string; created_at: string;
  provider_state: string | null; provider_reference: string | null; provider_receipt: string | null; last_error: string | null;
  receipt_reference: string | null; receipt_notes: string | null; received_by: string | null; paid_at: string | null; recorded_at: string | null; is_test: boolean;
}
export interface BillingDashboardData {
  money: { collected_minor: number; previous_minor: number; paid: number; pending: number; failed: number; review: number; refunded: number; awaiting_activation: number };
  access: { total: number; online: number; offline: number; unknown: number; active: number; expired: number; expiry_soon: number; paused: number; suspended: number; complimentary: number; failed_jobs: number };
  rows: (DashboardCustomer | DashboardTransaction)[]; total: number; offset: number; limit: number; as_of: string; timezone: string; view: string; live_accounting_available: boolean;
  trend: { day: string; amount_minor: number; paid: number; failed: number }[];
  breakdown: { payment_method: string; transactions: number; amount_minor: number }[];
  packages: { name: string; paid: number; amount_minor: number }[];
}
export interface ManualReceiptInput { request_key: string; method: string; reference: string; paid_at: string; notes: string; confirm_received: boolean }
export const billingDashboardApi = {
  get: (params: DashboardFilters,signal?: AbortSignal) => api.get<BillingDashboardData>('/billing/dashboard',{ params,signal }).then((r) => r.data),
  recordManual: (id: string,body: ManualReceiptInput) => api.post(`/billing/payments/${id}/manual-receipt`,body).then((r) => r.data),
};
