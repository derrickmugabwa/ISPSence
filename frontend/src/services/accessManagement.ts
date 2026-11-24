import api from './api';

export interface AccessWindow { days: number[]; start: string; end: string }
export interface AccessSchedule { enabled: boolean; timezone: string; windows: AccessWindow[] }
export interface AccessDevice { id: string; label: string; mac: string; enabled: boolean; version: number }
export interface AccessAlert { mode: 'simulation' | 'live' | null; id: string; customer_id: number; customer_name?: string; subscription_id: string | null; kind: string; message: string; deadline: string | null; read_at: string | null; created_at: string }
export interface AccessManagement {
  devices: AccessDevice[];
  policy: { version: number; max_devices: number; max_sessions: number; registered_only: boolean; schedule: AccessSchedule };
  controls: { version: number; desired_state: string; resume_at: string | null };
  jobs: { worker_state?:string|null;worker_code?:string|null;worker_attempts?:number|null; id: string; kind: string; status: string; reason: string; actor: string; last_error: string | null; created_at: string; updated_at: string }[];
  events: { id: string; kind: string; reason: string; actor: string; created_at: string }[];
  alerts: AccessAlert[];
  renewals: { predecessor_id: string; successor_id: string; status: string }[];
  schedule_allowed_now: boolean;
}
const base = '/billing/access-management';
export const accessManagementApi = {
  get: (id: string) => api.get<AccessManagement>(`${base}/customers/${id}`).then((r) => r.data),
  change: (id: string, path: string, body: Record<string,unknown>, method: 'post' | 'put' = 'post') => (method === 'put' ? api.put(`${base}/customers/${id}/${path}`,body) : api.post(`${base}/customers/${id}/${path}`,body)),
  alerts: () => api.get<AccessAlert[]>(`${base}/alerts`).then((r) => r.data),
  read: (id: string) => api.post(`${base}/alerts/${id}/read`),
};
