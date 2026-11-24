import { tool } from 'ai';
import { z } from 'zod';
import { fluxString } from '@influxdata/influxdb-client';
import { query } from '../../config/database';
import { getQueryApi,bucket } from '../../config/influxdb';
type SafeCheck=(name:string,work:()=>Promise<unknown>)=>Promise<unknown>;
export interface TrafficSample {field:string;time:string;value:unknown}
const maxAgeSeconds=180;
function counter(value:unknown):bigint | null {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
  if(typeof value==='string' && /^\d{1,20}$/.test(value))return BigInt(value);
  return null;
}
export function sampledBandwidth(samples:TrafficSample[],now=new Date()){
  function direction(field:string){
    const rows=samples.filter(r=>r.field===field).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)).slice(0,2);
    if(rows.length<2)return {bps:null,reason:'insufficient_samples',sampled_at:rows[0]?.time ?? null};
    const [latest,previous]=rows,a=counter(latest.value),b=counter(previous.value),end=Date.parse(latest.time),start=Date.parse(previous.time),seconds=(end-start)/1000,age=(now.getTime()-end)/1000;
    const interval={sampled_at:latest.time,interval_start:previous.time,interval_seconds:seconds};
    if(!Number.isFinite(seconds)||seconds<=0||!Number.isFinite(age)||age< -5 || a===null || b===null)return {...interval,bps:null,reason:'invalid_samples'};
    if(a<b)return {...interval,bps:null,reason:'counter_reset'};
    if(seconds>maxAgeSeconds)return {...interval,bps:null,reason:'sampling_gap'};
    const delta=a-b;if(delta>BigInt(Number.MAX_SAFE_INTEGER))return {...interval,bps:null,reason:'invalid_samples'};
    return {...interval,bps:Number(delta)*8/seconds,age_seconds:Math.max(0,age),fresh:age<=maxAgeSeconds,reason:age>maxAgeSeconds?'stale':'sampled'};
  }
  return {receive:direction('rx_bytes'),transmit:direction('tx_bytes'),rate_unit:'bits_per_second',freshness_threshold_seconds:maxAgeSeconds,source:'collected_router_interface_counters',perspective:'router interface: RX received by router, TX sent by router; these are not automatically customer download/upload',live_customer_accounting_available:false,warning:'Sampled average between two polls, not an instantaneous probe. Do not sum WAN, bridge and LAN interfaces: the same traffic can be counted multiple times.'};
}
export function bandwidthChatTools(safe:SafeCheck){return {
  listRouterInterfaces:tool({description:'List saved interfaces for a router, including names needed by getInterfaceBandwidth, running/disabled flags and inventory update time. Link speed is a configured/reported capacity string, not measured throughput. Use getRouterStatus to find a router ID first.',inputSchema:z.object({deviceId:z.number().int().positive().max(2147483647),limit:z.number().int().min(1).max(20).default(10),offset:z.number().int().min(0).max(10000).default(0)}).strict(),execute:({deviceId,limit,offset})=>safe('listRouterInterfaces',async()=>{
    const rows=await query('SELECT name,type,running,disabled,speed AS reported_link_capacity,updated_at FROM interfaces WHERE device_id=$1 ORDER BY name,id LIMIT $2 OFFSET $3',[deviceId,limit+1,offset]);
    return {device_id:deviceId,items:rows.slice(0,limit),has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null,limit,offset,href:`/devices/${deviceId}`};
  })}),
  getInterfaceBandwidth:tool({description:'Read measured router-interface bandwidth from the latest two collected RX/TX byte counters within 15 minutes. Returns bits/second averaged over the actual sample interval and sample timestamps. Fresh means <=180 seconds; stale readings are historical, never current. Missing data, resets and polling gaps return null, not zero. RX/TX is from the router perspective, not customer download/upload. No fresh router probe and no customer-attributed usage. Choose the intended WAN/uplink interface; never sum all interfaces as total internet usage.',inputSchema:z.object({deviceId:z.number().int().positive().max(2147483647),interfaceName:z.string().trim().min(1).max(50)}).strict(),execute:({deviceId,interfaceName})=>safe('getInterfaceBandwidth',async()=>{
    const device=(await query('SELECT d.id,d.name,d.status,d.last_seen FROM devices d JOIN interfaces i ON i.device_id=d.id WHERE d.id=$1 AND i.name=$2',[deviceId,interfaceName]))[0];
    if(!device)return {available:false,reason:'unknown_device_or_interface',receive:null,transmit:null};
    const flux=`from(bucket: ${fluxString(bucket)}) |> range(start: -15m)
      |> filter(fn: (r) => r._measurement == "interface_traffic" and r.device_id == ${fluxString(String(deviceId))} and r.interface == ${fluxString(interfaceName)})
      |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes")
      |> group(columns: ["_field"]) |> sort(columns: ["_time"], desc: true) |> limit(n: 2)`;
    const rows=await getQueryApi().collectRows<TrafficSample>(flux,(values,meta)=>({field:String(meta.get(values,'_field')),time:String(meta.get(values,'_time')),value:meta.get(values,'_value')}));
    return {device,interface:interfaceName,...sampledBandwidth(rows),href:`/devices/${deviceId}`};
  })}),
};}
