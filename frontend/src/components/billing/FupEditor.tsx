import type { FupPolicy } from '../../services/fup';
import { defaultFup } from '../../services/fup';
import { billingInput as input,billingSecondary as secondary } from './BillingUi';
export default function FupEditor({value,onChange,optional=true}:{value:FupPolicy|null;onChange:(p:FupPolicy|null)=>void;optional?:boolean}) {
 const p=value;
 return <div className="space-y-4 rounded-lg border border-line p-4">
 <div><h3 className="text-sm font-semibold">Fair usage policy</h3><p className="mt-1 text-xs text-ink-3">Usage is shared across sessions within each access period. Hard data caps, suspension and expiry still take precedence.</p></div>
 {optional && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!p} onChange={e=>onChange(e.target.checked?defaultFup():null)} /> Enable FUP</label>}
 {p && <><div className="grid gap-3 sm:grid-cols-2">
 <label className="text-sm text-ink-2">Count usage<select className={input} value={p.direction} onChange={e=>onChange({...p,direction:e.target.value as FupPolicy['direction']})}><option value="combined">Download + upload</option><option value="download">Download only</option><option value="upload">Upload only</option></select></label>
 <label className="text-sm text-ink-2">Reset usage<select className={input} value={p.reset} onChange={e=>onChange({...p,reset:e.target.value as FupPolicy['reset']})}><option value="subscription">Each access period</option><option value="daily">Daily at midnight</option><option value="weekly">Weekly on Monday</option><option value="monthly">Monthly on day 1</option></select></label>
 <label className="text-sm text-ink-2">Reset timezone<input required maxLength={80} className={input} value={p.timezone} onChange={e=>onChange({...p,timezone:e.target.value})} placeholder="Africa/Nairobi" /></label>
 <label className="text-sm text-ink-2">Warning threshold (%)<input required type="number" min="1" max="99" step="1" className={input} value={p.warning_percent} onChange={e=>onChange({...p,warning_percent:Number(e.target.value)})} /></label>
 </div>
 <div className="space-y-3">{p.tiers.map((t,i)=><div key={i} className="space-y-3 rounded-lg bg-surface-2 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">Stage {i+1}</span><button type="button" className="text-xs text-ink-3 hover:text-bad" disabled={p.tiers.length===1} onClick={()=>onChange({...p,tiers:p.tiers.filter((_,n)=>n!==i)})}>Remove stage {i+1}</button></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
 <label className="text-xs text-ink-2">After usage (GB)<input required type="number" min="0.001" step="0.001" max="1000000" className={input} value={t.threshold_bytes/1e9} onChange={e=>onChange({...p,tiers:p.tiers.map((s,n)=>n===i?{...s,threshold_bytes:Math.round(Number(e.target.value)*1e9)}:s)})} /></label>
 <label className="text-xs text-ink-2">Action<select className={input} value={t.action} onChange={e=>onChange({...p,tiers:p.tiers.map((s,n)=>n===i?e.target.value==='block'?{threshold_bytes:s.threshold_bytes,action:'block'}:{...s,action:'throttle',download_bps:5e6,upload_bps:2e6}:s)})}><option value="throttle">Limit speed</option><option value="block">Block access</option></select></label>
 {t.action==='throttle' && <><label className="text-xs text-ink-2">Download (Mbps)<input required type="number" min="0.001" max="1000000" step="0.001" className={input} value={(t.download_bps??0)/1e6} onChange={e=>onChange({...p,tiers:p.tiers.map((s,n)=>n===i?{...s,download_bps:Math.round(Number(e.target.value)*1e6)}:s)})} /></label><label className="text-xs text-ink-2">Upload (Mbps)<input required type="number" min="0.001" max="1000000" step="0.001" className={input} value={(t.upload_bps??0)/1e6} onChange={e=>onChange({...p,tiers:p.tiers.map((s,n)=>n===i?{...s,upload_bps:Math.round(Number(e.target.value)*1e6)}:s)})} /></label></>}
 </div></div>)}</div>
 <button type="button" className={secondary} disabled={p.tiers.length>=8||p.tiers[p.tiers.length-1]?.action==='block'} onClick={()=>{const last=p.tiers[p.tiers.length-1]!;onChange({...p,tiers:[...p.tiers,{threshold_bytes:last.threshold_bytes+100e9,action:'throttle',download_bps:last.download_bps??5e6,upload_bps:last.upload_bps??2e6}]});}}>Add FUP stage</button>
 <p className="text-xs text-ink-3">Up to 8 stages. Thresholds must increase and speeds cannot increase between stages. FUP limits never raise a customer’s configured speed. Resets restore the normal speed ceiling; they do not extend access time. 1 GB = 1 billion bytes.</p></>}
 </div>;
}
