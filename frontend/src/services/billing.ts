import api from './api';
import type { PackageInput } from './billingPackages';

export interface CustomerInput { first_device_mac?: string; first_device_label?: string; full_name: string; phone: string; notes: string }
export interface Customer extends Omit<CustomerInput, 'phone'> {
  id: number; customer_code: string; phone: string | null; version: number; payment_count: number; created_at: string; updated_at: string;
}
export interface PaymentInput { service_id?: string; customer_id: number; package_id: number; package_version: number; payer_phone: string; request_key: string }
export interface Payment {
  service_id?: string | null; service_username?: string | null; service_label?: string | null;
  id: string; reference: string; customer_id: number; package_id: number; payer_phone: string;
  amount_minor: number; currency: string; package_snapshot: PackageInput & { package_version: number; service_type?: 'hotspot' | 'pppoe'; service_id?: string };
  payment_status: 'pending' | 'paid' | 'failed' | 'needs_review' | 'refunded';
  access_status: 'not_activated' | 'awaiting_activation' | 'active' | 'expired' | 'needs_review';
  customer_name: string; customer_code: string; customer_phone: string | null; created_at: string;
}
export const customersApi = {
  list: () => api.get<Customer[]>('/billing/customers').then((r) => r.data),
  create: (body: CustomerInput) => api.post<Customer>('/billing/customers', body),
  update: (id: number, body: CustomerInput & { version: number }) => api.put<Customer>(`/billing/customers/${id}`, body),
};
export const paymentsApi = {
  list: (customerId?: string) => api.get<Payment[]>('/billing/payments', { params: customerId ? { customer_id: customerId } : {} }).then((r) => r.data),
  create: (body: PaymentInput) => api.post<Payment>('/billing/payments', body),
};
