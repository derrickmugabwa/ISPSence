import api from './api';
export interface RadiusRecord {
  id: string; source_ip: string; nas_identifier: string; username: string; session_key: string;
  first_received_at: string; last_received_at: string; elapsed_seconds: number;
  download_bytes: number; upload_bytes: number; start_seen: boolean; stop_seen: boolean; ambiguous: boolean;
}
export interface RadiusDiagnostics {
  configured: boolean; mode: 'private_lab'; live_authorization: false;
  summary: { packet_count: number; last_received_at: string | null };
  records: RadiusRecord[]; total: number; offset: number; limit: number;
}
export interface PipelineDiagnostics {accounting:{received:number;pending:number;attention:number;last_received_at:string|null};provisioning:{state:string;total:number}[];sources:{id:string;device_id:number;source_ip:string;nas_identifier:string;enabled:boolean;interim_seconds:number;version:number}[];health:{name:string;last_succeeded_at:string|null;last_code:string|null}[];sessions:{total:number;unmapped:number;stale:number};authorization_enabled:false}
export const billingRadiusApi = {
  pipeline:()=>api.get<PipelineDiagnostics>('/billing/radius/pipeline').then(r=>r.data),
  get: (offset: number) => api.get<RadiusDiagnostics>('/billing/radius',{ params: { offset } }).then((r) => r.data),
};
