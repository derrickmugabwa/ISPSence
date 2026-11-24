import api from './api';

export interface CustomerService {
  id: string; customer_id: number; service_type: 'hotspot' | 'pppoe'; mode: 'live' | 'simulation';
  username: string; label: string; state: 'draft' | 'legacy'; version: number; created_at: string;
  prepared_periods?: number; credential_revision: number | null; credentials_updated_at: string | null;
  binding?: { device_id: number; router_name: string; server_id: string; service_name: string; interface_name: string; profile_name: string; pool_name: string; cpe_mac: string | null; version: number; status: 'pending' } | null;
}
export interface BindingInput { version: number; discovery_id: string; server_id: string; profile_name: string; pool_name: string; cpe_mac: string | null; reason: string; request_key: string }
export interface RouterDiscovery {
  id: string; device_id: number; service_version: number; expires_at: string;
  inventory: {
    ros_version: string;
    servers: { id: string; service_name: string; interface: string; default_profile: string; disabled: boolean; authentication: string[] }[];
    profiles: { name: string; local_address: string; remote_address: string }[];
    pools: { name: string; ranges: string }[];
    radius_enabled: boolean; ppp_radius_clients: number; local_username_collision: boolean;
  };
}
export interface ServiceDraftInput { customer_id: number; label: string; username?: string; reason: string; request_key: string }
export interface CredentialInput { version: number; reason: string; request_key: string }
export const customerServicesApi = {
  routers: () => api.get<{ id: number; name: string; ros_version: string | null; status: string; ssh_only: boolean }[]>('/billing/customer-services/routers').then((r) => r.data),
  discover: (id: string,body: { device_id: number; version: number }) => api.post<RouterDiscovery>(`/billing/customer-services/${id}/discover`,body).then((r) => r.data),
  bind: (id: string,body: BindingInput) => api.post<{ service: CustomerService; replayed: boolean }>(`/billing/customer-services/${id}/binding`,body).then((r) => r.data),
  list: (customerId: string) => api.get<CustomerService[]>('/billing/customer-services',{ params: { customer_id: customerId } }).then((r) => r.data),
  create: (body: ServiceDraftInput) => api.post<{ service: CustomerService; replayed: boolean }>('/billing/customer-services',body).then((r) => r.data),
  credentials: (id: string,body: CredentialInput) => api.post<{ service: CustomerService; password: string | null; replayed: boolean }>(`/billing/customer-services/${id}/credentials`,body).then((r) => r.data),
};
