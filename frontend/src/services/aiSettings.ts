import api from './api';
export type AiProvider='deepseek' | 'openai' | 'google';
export interface AiConnection {
  id: string; provider: AiProvider; label: string; enabled: boolean; models: string[]; version: number;
  credentials_configured: boolean; last_test_at: string | null; last_test_code: string | null; available_models: string[];
}
export interface AiSettings {
  version: number; default_connection_id: string | null; default_model: string | null;
  requests_per_user_day: number; max_output_tokens: number; max_tool_steps: number; retention_days: number;
  connections: AiConnection[]; providers: {id: AiProvider;name: string;origin: string}[];
  connection_checks_today: number; assistant_available: boolean;
}
export interface AiConnectionInput {version: number;provider: AiProvider;label: string;enabled: boolean;models: string[];api_key?: string;remove_credentials?: boolean}
export type AiDefaults=Pick<AiSettings,'version' | 'default_connection_id' | 'default_model' | 'requests_per_user_day' | 'max_output_tokens' | 'max_tool_steps' | 'retention_days'>;
// Axios errors retain request bodies. Discard those before mutation caches and
// UI error handlers can retain a submitted API credential.
async function safe<T>(request: Promise<{data:T}>): Promise<T> {
  try {return (await request).data;} catch(error) {
    const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;
    throw new Error(typeof message==='string' ? message : 'Unable to update AI settings. Check your connection and try again.');
  }
}
export const aiSettingsApi={
  get:()=>safe(api.get<AiSettings>('/ai/settings')),
  saveConnection:(id: string | null,body: AiConnectionInput)=>safe(id ? api.put<AiSettings>(`/ai/settings/connections/${id}`,body) : api.post<AiSettings>('/ai/settings/connections',body)),
  remove:(id: string,version: number)=>safe(api.delete<AiSettings>(`/ai/settings/connections/${id}`,{data:{version}})),
  defaults:(body: AiDefaults)=>safe(api.put<AiSettings>('/ai/settings/defaults',body)),
  test:(id: string,version: number)=>safe(api.post<{connected:boolean;code:string;models:string[];truncated:boolean}>(`/ai/settings/connections/${id}/test`,{version})),
};
