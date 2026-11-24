export interface FupTier { threshold_bytes: number; action: 'throttle' | 'block'; download_bps?: number; upload_bps?: number }
export interface FupPolicy { version: 1; direction: 'download' | 'upload' | 'combined'; reset: 'subscription' | 'daily' | 'weekly' | 'monthly'; timezone: string; warning_percent: number; tiers: FupTier[] }
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Record<string,unknown>,allowed: string[]) { if(Object.keys(v).some(k=>!allowed.includes(k))) throw new Error('Unsupported FUP field'); }
function positive(v: unknown,max: number) { if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>max) throw new Error('FUP thresholds and speeds must be positive whole numbers within range');return v; }
export function parseFup(v: unknown): FupPolicy | null {
  if(v===null)return null;
  if(!object(v))throw new Error('Choose a valid FUP policy');
  keys(v,['version','direction','reset','timezone','warning_percent','tiers']);
  if(v.version!==1 || (typeof v.direction!=='string'||!['download','upload','combined'].includes(v.direction)) || (typeof v.reset!=='string'||!['subscription','daily','weekly','monthly'].includes(v.reset)) || typeof v.timezone!=='string' || v.timezone.length>80 || typeof v.warning_percent!=='number' || !Number.isInteger(v.warning_percent) || v.warning_percent<1 || v.warning_percent>99 || !Array.isArray(v.tiers) || v.tiers.length<1 || v.tiers.length>8)throw new Error('Choose FUP usage direction, reset period, warning percentage (1–99), timezone and 1–8 stages');
  try { if(/^[+-]/.test(v.timezone))throw new Error('Offset timezone');new Intl.DateTimeFormat('en',{timeZone:v.timezone}); } catch {throw new Error('Choose a valid FUP timezone');}
  let previous=0,down=Infinity,up=Infinity,blocked=false;
  const tiers=v.tiers.map(t=>{
    if(!object(t))throw new Error('Invalid FUP stage');keys(t,['threshold_bytes','action','download_bps','upload_bps']);
    const threshold=positive(t.threshold_bytes,1e15);
    if(blocked || threshold<=previous || (typeof t.action!=='string'||!['throttle','block'].includes(t.action)))throw new Error('FUP thresholds must increase; a blocking stage must be last');
    previous=threshold;
    if(t.action==='block'){if(t.download_bps!==undefined||t.upload_bps!==undefined)throw new Error('A blocking stage has no speeds');blocked=true;return {threshold_bytes:threshold,action:'block' as const};}
    const d=positive(t.download_bps,1e12),u=positive(t.upload_bps,1e12);
    if(d>down||u>up)throw new Error('Later FUP stages cannot increase either speed');down=d;up=u;
    return {threshold_bytes:threshold,action:'throttle' as const,download_bps:d,upload_bps:u};
  });
  return {version:1,direction:v.direction as FupPolicy['direction'],reset:v.reset as FupPolicy['reset'],timezone:v.timezone,warning_percent:v.warning_percent,tiers};
}
// Accounting adapters must supply complete, deduplicated byte deltas for this exact window.
// Full session counters spanning resets are not valid calendar-window usage.
export function evaluateFup(policy: FupPolicy | null,usage: {download_bytes:number;upload_bytes:number;lifetime_total_bytes?:number}|null,base: {download_bps:number;upload_bps:number;allowance_bytes:number|null;access_allowed:boolean}) {
  if(!base.access_allowed)return {state:'blocked',reason:'access_not_allowed',download_bps:null,upload_bps:null};
  if(!usage || !Number.isSafeInteger(usage.download_bytes)||!Number.isSafeInteger(usage.upload_bytes)||usage.download_bytes<0||usage.upload_bytes<0||!Number.isSafeInteger(usage.download_bytes+usage.upload_bytes))return {state:'unavailable',reason:'verified_window_accounting_required',download_bps:null,upload_bps:null};
  const total=usage.download_bytes+usage.upload_bytes;
  // Hard allowance is separate from FUP and takes precedence over any exemption.
  if(base.allowance_bytes!==null && (!Number.isSafeInteger(usage.lifetime_total_bytes) || usage.lifetime_total_bytes! < total))return {state:'unavailable',reason:'verified_lifetime_accounting_required',download_bps:null,upload_bps:null};
  if(base.allowance_bytes!==null && usage.lifetime_total_bytes! >= base.allowance_bytes)return {state:'blocked',reason:'hard_data_cap',download_bps:null,upload_bps:null};
  if(!policy)return {state:'normal',warning:false,download_bps:base.download_bps,upload_bps:base.upload_bps};
  const used=policy.direction==='download'?usage.download_bytes:policy.direction==='upload'?usage.upload_bytes:total;
  const reached=policy.tiers.filter(t=>used>=t.threshold_bytes),stage=reached.at(-1),next=policy.tiers[reached.length];
  const context={used_bytes:used,stage:reached.length,next_threshold_bytes:next?.threshold_bytes??null,warning:!!next&&used>=Math.ceil(next.threshold_bytes*policy.warning_percent/100)};
  if(stage?.action==='block')return {...context,state:'blocked',reason:'fup_stage',download_bps:null,upload_bps:null};
  return {...context,state:stage?'throttled':'normal',download_bps:Math.min(base.download_bps,stage?.download_bps??base.download_bps),upload_bps:Math.min(base.upload_bps,stage?.upload_bps??base.upload_bps)};
}
