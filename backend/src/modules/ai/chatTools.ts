import { customerFup } from '../billing/fupSettings';
import { tool } from 'ai';
import { z } from 'zod';
import { query } from '../../config/database';
import { customerProfile } from '../billing/customerAccess';
import { accessManagementView } from '../billing/accessManagement';
import { subscriptionList } from '../billing/subscriptions';
import { sessionList } from '../billing/sessions';
import { billingDashboard, dashboardInput } from '../billing/billingDashboard';
import { expandedChatTools } from './chatReadTools';
import { bandwidthChatTools } from './chatBandwidthTools';
import { consolidateChatTools,type SafeCheck } from './chatCatalogue';

const customerId=z.number().int().positive().max(2147483647);
const connectionType=z.enum(['all','hotspot','pppoe']).default('all');
export type ChatToolGuard=()=>Promise<void>;
function individualTools(safe:SafeCheck) {
  return {
    ...expandedChatTools(safe),
    ...bandwidthChatTools(safe),
    getCustomerAccess:tool({description:'Explain a selected customer from billing, requested/applied access, schedule, speed override and provisioning records. Live enforcement may be unavailable. A requested state is not proof of router enforcement. Does not diagnose CPE Wi-Fi or prove internet reachability.',inputSchema:z.object({customerId,connectionType}).strict(),execute:({customerId,connectionType})=>safe('getCustomerAccess',async()=>{
      const mode='all';
      const [profile,management,periods,sessions,fup]=await Promise.all([customerProfile(customerId),accessManagementView(customerId),subscriptionList(customerId),sessionList('','all',0,customerId),customerFup(customerId)]);
      return {customer:{id:customerId,name:profile.customer.full_name,number:profile.customer.customer_code,href:`/billing/customers/${customerId}`},
        requested_state:management.controls.desired_state,schedule_allowed_now:management.schedule_allowed_now,
        connection_limit:management.policy.max_sessions,registered_devices:management.devices.length,
        speed_override:{download_bps:profile.network.download_bps,upload_bps:profile.network.upload_bps,enforcement:profile.enforcement},
        live_adapter_connected:management.live_adapter_connected,live_session_status:'unknown',
        periods:periods.filter(p=>(connectionType==='all' || p.service_type===connectionType)&&(mode==='all'||p.mode===mode)).slice(0,8).map(p=>({id:p.id,mode:p.mode,service_type:p.service_type,funding:p.funding,payment_status:p.payment_status,access_state:p.access_state,requested_state:p.desired_access_state,applied_state:p.applied_access_state,expires_at:p.expires_at})),
        fup:{setting:fup.setting,effective_mode:fup.effective_mode,enforcement:fup.enforcement,periods:fup.periods.slice(0,5),has_more:fup.periods.length>5},recorded_sessions:sessions.summary,provisioning:management.jobs.slice(0,5).map(j=>({kind:j.kind,status:j.status,created_at:j.created_at})),
        alerts:management.alerts.slice(0,8).map(a=>({kind:a.kind,mode:a.mode,created_at:a.created_at}))};
    })}),
    getBillingSummary:tool({description:'Use the existing billing dashboard calculations from saved records for KES receipts and access aggregates. Excludes simulated receipts from collected revenue. Dates use Africa/Nairobi, at most 93 days. Live session telemetry is unavailable; do not present simulation/unknown status as real online counts.',inputSchema:z.object({start:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),end:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),execute:({start,end})=>safe('getBillingSummary',async()=>{
      const mode='all';
      const r=await billingDashboard(dashboardInput({start,end,mode:'records'}));
      return {start,end,mode,currency:'KES',amount_unit:'minor units (100 = KES 1)',money:r.money,access:r.access,as_of:r.as_of,timezone:r.timezone,live_accounting_available:r.live_accounting_available,href:'/dashboard'};
    })}),
    listExpiringSubscriptions:tool({description:'Browse effective active subscriptions expiring over the next 1-30 days, with service-type filters and pagination. Retains original record provenance; prepared periods with no effective expiry are not expiring subscriptions.',inputSchema:z.object({days:z.number().int().min(1).max(30).default(1),connectionType,limit:z.number().int().min(1).max(20).default(10),offset:z.number().int().min(0).max(10000).default(0)}).strict(),execute:({days,connectionType,limit,offset})=>safe('listExpiringSubscriptions',async()=>{
      const mode='all';
      // Fixed application query: model arguments are parameter values only.
      const rows=await query(`SELECT c.id AS customer_id,c.customer_code,c.full_name,s.id,s.mode,s.status,
        coalesce(r.effective_expires_at,s.expires_at) AS expires_at,coalesce(cs.service_type,'hotspot') AS service_type
        FROM billing_subscriptions s LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
        JOIN billing_customers c ON c.id=coalesce(p.customer_id,g.customer_id)
        LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id
        LEFT JOIN billing_customer_services cs ON cs.id=coalesce(p.service_id,g.service_id)
        WHERE s.status='active' AND ($3='all' OR s.mode=$3) AND coalesce(r.effective_expires_at,s.expires_at)>now() AND coalesce(r.effective_expires_at,s.expires_at)<=now()+$1*interval '1 day'
        AND r.revoked_at IS NULL AND r.frozen_remaining_ms IS NULL AND ($2='all' OR coalesce(cs.service_type,'hotspot')=$2)
        ORDER BY expires_at,s.id LIMIT $4 OFFSET $5`,[days,connectionType,mode,limit+1,offset]);
      return {items:rows.slice(0,limit).map(r=>({...r,href:`/billing/customers/${r.customer_id}`})),limit,offset,has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null};
    })}),

  };
}

export function chatTools(guard:ChatToolGuard,audit:(name:string,ok:boolean)=>Promise<void>) {
  let calls=0;
  async function safe(name:string,work:()=>Promise<unknown>) {
    await guard();if (++calls>10) return {ok:false,error:'Tool-call limit reached'};
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      const result=await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tool timeout')),6000);})]);
      await guard();
      if (JSON.stringify(result).length>18000) throw new Error('Result too large');
      await audit(name,true);return {ok:true,as_of:new Date().toISOString(),data:result};
    } catch {await audit(name,false);return {ok:false,error:'This check is unavailable. Do not infer a customer state from the failure.'};}
    finally {if(timer)clearTimeout(timer);}
  }
  return consolidateChatTools(individualTools(async(_name,work)=>work()),safe);
}
