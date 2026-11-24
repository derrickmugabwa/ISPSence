import api from './api';
export interface FupTier { threshold_bytes:number; action:'throttle'|'block'; download_bps?:number;upload_bps?:number }
export interface FupPolicy { version:1;direction:'download'|'upload'|'combined';reset:'subscription'|'daily'|'weekly'|'monthly';timezone:string;warning_percent:number;tiers:FupTier[] }
export const defaultFup = ():FupPolicy => ({version:1,direction:'combined',reset:'subscription',timezone:'Africa/Nairobi',warning_percent:80,tiers:[{threshold_bytes:100e9,action:'throttle',download_bps:5e6,upload_bps:2e6}]});
export interface CustomerFupData {setting:{mode:'inherit'|'custom'|'exempt';policy:FupPolicy|null;expires_at:string|null;version:number};effective_mode:string;enforcement:string;periods:{id:string;package_name:string;status:string;policy:FupPolicy|null;source:string;usage_bytes:null;hard_allowance_bytes:number|null}[]}
export const fupApi={get:(id:string)=>api.get<CustomerFupData>('/billing/customers/'+id+'/fup').then(r=>r.data),save:(id:string,body:{mode:string;policy:FupPolicy|null;expires_at:string|null;version:number;reason:string})=>api.put<CustomerFupData>('/billing/customers/'+id+'/fup',body).then(r=>r.data)};
