import type { FupPolicy } from './fup';
import api from './api';
export interface PortalConfig {
  template: 'classic' | 'split' | 'minimal'; brand_name: string; headline: string; welcome_text: string;
  primary_color: string; background_color: string; logo_data_url: string | null;
  support_phone: string; support_label: string; terms_text: string; footer_text: string;
  show_packages: boolean; package_ids: number[];
  package_display?: { name: boolean; price: boolean; duration: boolean; download_speed: boolean; upload_speed: boolean; data_allowance: boolean };
}
export interface PortalTemplate { id: PortalConfig['template']; name: string; description: string; default_config: PortalConfig }
export interface PortalSummary { id: number; name: string; slug: string; version: number; template: PortalConfig['template']; published: boolean; published_version: number | null; published_at: string | null; updated_at: string; actor: string; has_unpublished_changes: boolean }
export interface PortalDetail extends Omit<PortalSummary,'published' | 'template'> {
  draft_config: PortalConfig; published_config: PortalConfig | null;
  history: { id: string; kind: string; version: number; actor: string; created_at: string }[];
}
export interface PortalPackage { fup_policy?: FupPolicy|null; id: number; name: string; amount_minor: number; currency: string; duration_value: number; duration_unit: string; download_bps: number; upload_bps: number; allowance_bytes: number | null; version: number }
export interface PublicPortal { config: PortalConfig; packages: PortalPackage[]; version: number; connection_available: false }
export const portalsApi = {
  list: () => api.get<PortalSummary[]>('/billing/portals').then((r) => r.data),
  templates: () => api.get<PortalTemplate[]>('/billing/portals/templates').then((r) => r.data),
  get: (id: string) => api.get<PortalDetail>(`/billing/portals/${id}`).then((r) => r.data),
  create: (body: { name: string; slug: string; config: PortalConfig }) => api.post<PortalDetail>('/billing/portals',body).then((r) => r.data),
  save: (id: string,body: { name: string; version: number; config: PortalConfig }) => api.put<PortalDetail>(`/billing/portals/${id}`,body).then((r) => r.data),
  publish: (id: string,version: number,publish: boolean) => api.post<PortalDetail>(`/billing/portals/${id}/${publish ? 'publish' : 'unpublish'}`,{ version }).then((r) => r.data),
  public: async (slug: string,signal?: AbortSignal): Promise<PublicPortal> => {
    // Public pages do not send dashboard credentials or follow its login redirects.
    const response = await fetch(`/api/public/portals/${encodeURIComponent(slug)}`,{ credentials: 'omit',cache: 'no-store',signal });
    if (!response.ok) throw new Error(response.status === 404 || response.status === 400 ? 'This Wi-Fi portal is not available.' : 'Unable to load this Wi-Fi portal. Please try again.');
    return response.json();
  },
};
