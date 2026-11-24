export interface AccountingObservation { kind:string;event_at:string;elapsed_seconds:number;download_bytes:number;upload_bytes:number }
export interface AccountingState {started_at:string;last_observed_at:string;stopped_at:string|null;elapsed_seconds:number;download_bytes:number;upload_bytes:number;start_seen:boolean;stop_seen:boolean;quality:string}
export function projectAccounting(previous:AccountingState|null,p:AccountingObservation,receivedAt:string){
 const time=Date.parse(p.event_at),received=Date.parse(receivedAt),validClock=time<=received+30000;
 const started=new Date(time-p.elapsed_seconds*1000).toISOString();
 const initial=p.kind==='Start'&&p.elapsed_seconds===0&&p.download_bytes===0&&p.upload_bytes===0;
 if(!previous){const quality=!validClock?'clock_skew':initial?'complete':'missing_start';return {state:{started_at:started,last_observed_at:p.event_at,stopped_at:p.kind==='Stop'?p.event_at:null,elapsed_seconds:p.elapsed_seconds,download_bytes:p.download_bytes,upload_bytes:p.upload_bytes,start_seen:p.kind==='Start',stop_seen:p.kind==='Stop',quality},quality,download_delta:initial&&validClock?0:null,upload_delta:initial&&validClock?0:null,interval_start:p.event_at,interval_end:p.event_at};}
 const prev=previous,old=time<Date.parse(prev.last_observed_at)||p.elapsed_seconds<prev.elapsed_seconds;
 const reused=p.kind==='Start'&&(prev.stop_seen||prev.elapsed_seconds>0);
 const reset=(time>Date.parse(prev.last_observed_at)&&p.elapsed_seconds<prev.elapsed_seconds)||(!old&&(p.download_bytes<prev.download_bytes||p.upload_bytes<prev.upload_bytes));
 const quality=reused?'session_reuse':!validClock?'clock_skew':reset?'counter_reset':prev.quality;
 if(prev.stop_seen||old||reused){return {state:{...prev,quality,stop_seen:prev.stop_seen||p.kind==='Stop',stopped_at:prev.stop_seen?prev.stopped_at:p.kind==='Stop'?new Date(Math.max(time,Date.parse(prev.last_observed_at))).toISOString():prev.stopped_at},quality:reused?'session_reuse':reset?'counter_reset':prev.stop_seen?'after_stop':'out_of_order',download_delta:null,upload_delta:null,interval_start:prev.last_observed_at,interval_end:prev.last_observed_at};}
 const complete=quality==='complete';
 return {state:{...prev,last_observed_at:p.event_at,stopped_at:p.kind==='Stop'?p.event_at:null,elapsed_seconds:p.elapsed_seconds,download_bytes:Math.max(prev.download_bytes,p.download_bytes),upload_bytes:Math.max(prev.upload_bytes,p.upload_bytes),start_seen:prev.start_seen||p.kind==='Start',stop_seen:p.kind==='Stop',quality},quality,download_delta:complete?p.download_bytes-prev.download_bytes:null,upload_delta:complete?p.upload_bytes-prev.upload_bytes:null,interval_start:prev.last_observed_at,interval_end:p.event_at};
}
