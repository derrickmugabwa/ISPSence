import api from './api';
export interface PayHeroSettings { version: number; enabled: boolean | null; mode: 'sandbox' | 'live' | null; base_url?: string; channel_id?: number; account_id?: number | null; public_origin?: string; credentials_configured: boolean }
export interface PayHeroConnection { version: number; mode: 'sandbox' | 'live'; base_url: string; username: string; password: string }
export interface PayHeroChannel { id: number; channel_type: string; account_id: number | null; short_code: string; account_number: string; description: string; is_active: boolean }
export interface PayHeroBank { id: string; name: string; paybill: string }
export interface PayHeroAttempt { id: string; mode: 'sandbox' | 'live'; state: string; provider_reference: string | null; receipt: string | null; last_error: string | null; created_at: string }
export interface PayHeroDetail { attempts: PayHeroAttempt[]; history: { kind: string; actor: string; created_at: string }[] }
export interface CheckoutStatus { id: string; reference: string; amount_minor: number; currency: string; payment_status: string; access_status: string; attempt: { mode: 'sandbox' | 'live'; state: string; last_error: string | null; receipt: string | null } }
export const payHeroApi = {
  settings: () => api.get<PayHeroSettings>('/billing/payhero/settings').then((r) => r.data),
  channels: (connection: PayHeroConnection) => api.post<{ channels: PayHeroChannel[] }>('/billing/payhero/channels/list',connection,{ timeout: 120000 }).then((r) => r.data),
  banks: (connection: PayHeroConnection) => api.post<{ banks: PayHeroBank[] }>('/billing/payhero/banks/list',connection).then((r) => r.data),
  registerBank: (body: { connection: PayHeroConnection; request_key: string; bank_id: string; account_id: number; account_number: string; description: string }) => api.post<{ channel: PayHeroChannel; existing: boolean }>('/billing/payhero/channels/bank',body,{ timeout: 120000 }).then((r) => r.data),
  saveSettings: (body: unknown) => api.put<PayHeroSettings>('/billing/payhero/settings',body).then((r) => r.data),
  test: () => api.post<{ connected: boolean; channel_active: boolean; message: string }>('/billing/payhero/test').then((r) => r.data),
  detail: (id: string) => api.get<PayHeroDetail>(`/billing/payhero/payments/${id}`).then((r) => r.data),
  collect: (id: string,key: string,mode: string) => api.post<PayHeroDetail>(`/billing/payhero/payments/${id}/collect`,{ request_key: key,mode }).then((r) => r.data),
  recheck: (id: string) => api.post(`/billing/payhero/attempts/${id}/recheck`),
};
async function publicRequest<T>(path: string,{ body,token,signal }: { body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/public/payhero${path}`,{ method: body === undefined ? 'GET' : 'POST',credentials: 'omit',cache: 'no-store',signal: signal ?? AbortSignal.timeout(20000),headers: { 'Content-Type': 'application/json',...(token ? { 'X-Checkout-Token': token } : {}) },...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || 'Unable to process this payment. Please try again later.'),{ status: response.status,code: data.code }); return data;
}
export const publicPayHeroApi = {
  availability: (signal?: AbortSignal) => publicRequest<{ enabled: boolean; mode: 'sandbox' | 'live' }>('/availability',{ signal }),
  create: (slug: string,body: unknown) => publicRequest<CheckoutStatus>(`/portals/${encodeURIComponent(slug)}/checkouts`,{ body }),
  status: (id: string,token: string,signal?: AbortSignal) => publicRequest<CheckoutStatus>(`/checkouts/${id}`,{ token,signal }),
  retry: (id: string,token: string,key: string) => publicRequest<CheckoutStatus>(`/checkouts/${id}/retry`,{ token,body: { request_key: key } }),
};
