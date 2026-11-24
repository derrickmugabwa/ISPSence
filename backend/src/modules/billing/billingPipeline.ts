import {query} from '../../config/database';
import {projectNextAccounting} from './accountingPipeline';
import {discoverProvisioning,runProvisioningOnce} from './provisioningWorker';
// No production router adapter is registered. Pending work remains visible and durable.
export function startBillingPipeline(){
 let active:Promise<void>|null=null,stopped=false;
 const tick=()=>{if(stopped||active)return;active=(async()=>{
 try{
 await query("INSERT INTO billing_pipeline_health(name,last_started_at) VALUES('network_pipeline',clock_timestamp()) ON CONFLICT(name) DO UPDATE SET last_started_at=EXCLUDED.last_started_at");
 for(let n=0;n<100;n++)if(!await projectNextAccounting())break;
 await discoverProvisioning();for(let n=0;n<25;n++)if(!await runProvisioningOnce())break;
 await query("UPDATE billing_pipeline_health SET last_succeeded_at=clock_timestamp(),last_code=NULL WHERE name='network_pipeline'");
 }catch{console.error('[billing pipeline] tick failed; durable work retained');await query("UPDATE billing_pipeline_health SET last_code='tick_failed' WHERE name='network_pipeline'").catch(()=>{});}
 })().finally(()=>{active=null;});};
 const timer=setInterval(tick,2000);timer.unref();tick();
 return async()=>{stopped=true;clearInterval(timer);await active;};
}
