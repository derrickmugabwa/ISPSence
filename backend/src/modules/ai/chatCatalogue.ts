import { tool } from 'ai';
import { z } from 'zod';
import { query } from '../../config/database';
import { sessionList } from '../billing/sessions';
import { dashboardInput } from '../billing/billingDashboard';
export type SafeCheck=(name:string,work:()=>Promise<unknown>)=>Promise<unknown>;
type ReadOperation={description?:string;inputSchema:z.ZodType;execute:(args:unknown,options:unknown)=>Promise<unknown>};
const customerId=z.number().int().positive().max(2147483647);
const connectionType=z.enum(['all','hotspot','pppoe']).default('all');
const paging={limit:z.number().int().min(1).max(20).default(10),offset:z.number().int().min(0).max(10000).default(0)};
const page=(rows:Record<string,unknown>[],limit:number,offset:number)=>({items:rows.slice(0,limit),limit,offset,has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null});
const pattern=(text:string)=>text?`%${text.replace(/[\\%_]/g,'\\$&')}%`:'';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export function consolidateChatTools(operations:object,safe:SafeCheck){
  // These readers are internal implementations, not additional model tools.
  // Only this catalogue is exposed; every call crosses the canonical guard once.
  const readers=new Map(Object.entries(operations) as unknown as [string,ReadOperation][]);
  async function read(name:string,args:unknown){const operation=readers.get(name);if(!operation)throw new Error('Unknown read operation');return operation.execute(operation.inputSchema.parse(args),{toolCallId:'internal-read',messages:[],context:{}});}
  const existing=(name:string)=>{const operation=readers.get(name)!;return tool({description:operation.description,inputSchema:operation.inputSchema,execute:args=>safe(name,()=>read(name,args))});};
  return {
    listCustomers:tool({description:'Search/browse the customer directory OR get exact customer counts with view=summary. Search matches name, number or phone; filters apply identically to list and counts. Every list includes a filtered summary and explicit pagination. Counts include customers without payments/services; requested enabled is not online. Service-type filters mean assigned services. No notes, phones or credentials are returned.',inputSchema:z.object({view:z.enum(['list','summary']).default('list'),search:z.string().trim().max(80).default(''),connectionType,requestedState:z.enum(['all','enabled','suspended','vacation']).default('all'),...paging}).strict(),execute:({view,search,connectionType,requestedState,limit,offset})=>safe('listCustomers',async()=>{
      const where=`FROM billing_customers c LEFT JOIN billing_customer_controls ctl ON ctl.customer_id=c.id
        WHERE ($1='' OR c.full_name ILIKE $1 OR c.customer_code ILIKE $1 OR c.phone ILIKE $1)
        AND ($2='all' OR EXISTS(SELECT 1 FROM billing_customer_services cs WHERE cs.customer_id=c.id AND cs.service_type=$2))
        AND ($3='all' OR coalesce(ctl.desired_state,'enabled')=$3)`;
      const params=[pattern(search),connectionType,requestedState];
      const summary=(await query(`SELECT count(*)::int AS total_customers,
        count(*) FILTER(WHERE coalesce(ctl.desired_state,'enabled')='enabled')::int AS requested_enabled,
        count(*) FILTER(WHERE ctl.desired_state='suspended')::int AS requested_suspended,
        count(*) FILTER(WHERE ctl.desired_state='vacation')::int AS requested_vacation,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM billing_customer_services cs WHERE cs.customer_id=c.id AND cs.service_type='hotspot'))::int AS customers_with_hotspot,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM billing_customer_services cs WHERE cs.customer_id=c.id AND cs.service_type='pppoe'))::int AS customers_with_pppoe ${where}`,params))[0];
      const context={view,filters:{search,connectionType,requestedState},summary,live_online_customers:null,live_accounting_available:false,href:'/billing/customers'};
      if(view==='summary')return context;
      const rows=await query(`SELECT c.id,c.customer_code,c.full_name,c.created_at,coalesce(ctl.desired_state,'enabled') AS requested_state ${where} ORDER BY c.id LIMIT $4 OFFSET $5`,[...params,limit+1,offset]);
      return {...context,...page(rows.map(c=>({...c,href:`/billing/customers/${c.id}`})),limit,offset)};
    })}),
    getCustomerAccess:tool({description:'Inspect one customer using view=overview, subscriptions, services, devices, schedule or history. Overview is a bounded diagnostic snapshot; select a section for paginated details. Subscriptions/services support Hotspot/PPPoE filters. Devices includes connection limits; schedule includes requested vacation/resume; history is structured audit metadata. Requested settings are not proof of enforcement or connectivity. Never returns credentials or private notes.',inputSchema:z.object({customerId,view:z.enum(['overview','subscriptions','services','devices','schedule','history']).default('overview'),connectionType,...paging}).strict().superRefine((v,ctx)=>{if(['devices','schedule','history'].includes(v.view)&&(v.connectionType!=='all'))ctx.addIssue({code:'custom',message:'Service-type filters apply to overview, subscriptions or services only'});}),execute:({customerId,view,connectionType,limit,offset})=>safe('getCustomerAccess',async()=>{
      switch(view){
        case 'overview':return {view,scope:'bounded_diagnostic_snapshot',details_hint:'Use a specific view for complete paginated details',...await read('getCustomerAccess',{customerId,connectionType}) as object};
        case 'subscriptions':return {view,...await read('listCustomerSubscriptions',{customerId,connectionType,limit,offset}) as object};
        case 'services':return {view,...await read('listCustomerServices',{customerId,connectionType,limit,offset}) as object};
        case 'devices':return {view,...await read('getCustomerDevices',{customerId,limit,offset}) as object};
        case 'schedule':return {view,...await read('getCustomerSchedule',{customerId}) as object};
        case 'history':return {view,...await read('getCustomerHistory',{customerId,limit,offset}) as object};
      }
    })}),
    getRouterStatus:tool({description:'Read router status/inventory with view=routers (search or deviceId), interfaces (deviceId required), or bandwidth (deviceId and exact interfaceName required). Use interfaces to select the WAN/uplink before bandwidth. Bandwidth is an average from actual sampled byte counters, with timestamps, freshness and reset/gap handling; not an instantaneous probe or per-customer usage. Link capacity is not throughput. Never sum overlapping interfaces or present stale samples as current. No commands or credentials.',inputSchema:z.object({view:z.enum(['routers','interfaces','bandwidth']).default('routers'),deviceId:customerId.optional(),interfaceName:z.string().trim().min(1).max(50).optional(),search:z.string().trim().max(80).default(''),...paging}).strict().superRefine((v,ctx)=>{
      if(v.view!=='routers'&&!v.deviceId)ctx.addIssue({code:'custom',message:'deviceId is required for interfaces or bandwidth'});
      if(v.view==='bandwidth'&&!v.interfaceName)ctx.addIssue({code:'custom',message:'interfaceName is required for bandwidth'});
      if(v.view!=='routers'&&v.search)ctx.addIssue({code:'custom',message:'Search applies to the router list only'});
      if(v.view!=='bandwidth'&&v.interfaceName)ctx.addIssue({code:'custom',message:'interfaceName applies to bandwidth only'});
    }),execute:({view,deviceId,interfaceName,search,limit,offset})=>safe('getRouterStatus',async()=>{
      if(view==='interfaces')return {view,...await read('listRouterInterfaces',{deviceId,limit,offset}) as object};
      if(view==='bandwidth')return {view,...await read('getInterfaceBandwidth',{deviceId,interfaceName}) as object};
      const rows=await query('SELECT id,name,status,last_seen,ros_version FROM devices WHERE ($1=\'\' OR name ILIKE $1) AND ($2::int IS NULL OR id=$2) ORDER BY name,id LIMIT $3 OFFSET $4',[pattern(search),deviceId ?? null,limit+1,offset]);
      return {view,...page(rows,limit,offset),observation:'last_reported',href:'/devices'};
    })}),
    listCustomerSessions:tool({description:'Read customer or fleet session history and usage with view=list or summary. Filter customerId, service type, status and paired Nairobi start/end dates (up to 93 days); sort by recent/download/upload/total_usage. Reads the same saved session records as the dashboard, including their original source. Recorded open sessions are not proof of current connectivity. Usage sums full stored session counters for sessions STARTED in the selected window, not exact calendar-window traffic, current bandwidth or remaining cap. No live rates are available.',inputSchema:z.object({customerId:customerId.optional(),view:z.enum(['list','summary']).default('list'),connectionType,status:z.enum(['all','active','ended']).default('all'),start:date.optional(),end:date.optional(),sort:z.enum(['recent','download','upload','total_usage']).default('recent'),...paging}).strict().superRefine((v,ctx)=>{if(Boolean(v.start)!==Boolean(v.end))ctx.addIssue({code:'custom',message:'Supply both start and end dates'});}),execute:({customerId,view,connectionType,status,start,end,sort,limit,offset})=>safe('listCustomerSessions',async()=>{
      const mode='all';
      if(start&&end)dashboardInput({start,end});
      const context={view,mode,customer_id:customerId ?? null,filters:{connectionType,status,start:start ?? null,end:end ?? null,sort},live_accounting_available:false,live_sessions:null,current_download_bps:null,current_upload_bps:null,href:customerId?`/billing/customers/${customerId}`:'/billing/sessions'};
      const r=await sessionList('',status,offset,customerId,{start,end,connectionType,sort});
      const result={...context,available:true,usage_scope:'stored_records; full counters of sessions starting in the selected window; not traffic consumed exactly within that window',summary:r.summary};
      if(view==='summary')return result;
      return {...result,...page(r.items.slice(0,limit+1).map(s=>({id:s.id,customer_id:s.customer_id,customer_code:s.customer_code,customer_name:s.customer_name,source:s.source,quality:s.quality,freshness:s.freshness,router_label:s.router_label,started_at:s.started_at,ended_at:s.ended_at,end_reason:s.end_reason,duration_seconds:s.duration_seconds,download_bytes:s.download_bytes,upload_bytes:s.upload_bytes})),limit,offset)};
    })}),
    getBillingSummary:existing('getBillingSummary'),
    listPayments:existing('listPayments'),
    listPackages:existing('listPackages'),
    listExpiringSubscriptions:existing('listExpiringSubscriptions'),
    listAccessAlerts:existing('listAccessAlerts'),
    listProvisioningJobs:existing('listProvisioningJobs'),
  };
}
