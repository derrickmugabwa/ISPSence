// Invoked inside the disposable saved-credential DB fixture, never production.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
module.exports=async function checkProvisioning({pool,lab,make,request,account,denied,getNow,setNow,schema}){
  const {runPppoeProvisioningOnce:run}=require('/app/dist/modules/billing/pppoeProvisioning');
  const {PppoeLab}=require('/app/dist/modules/billing/pppoeLab');
  const advance=ms=>setNow(new Date(getNow().getTime()+ms));
  const operation=async id=>(await pool.query('SELECT * FROM pppoe_lab_operations WHERE id=$1',[id])).rows[0];
  const period=async f=>(await pool.query('SELECT * FROM pppoe_lab_periods WHERE subscription_id=$1',[f.period])).rows[0];
  const fixture=async(kind='paid',options={})=>{
    const f=await make(kind,options),r=await lab.authenticate(request(f));f.reply=r;f.admission=r['reply:Class'].slice(4);f.session=randomUUID();
    await lab.accounting(account(f,r,'Start',f.session));f.key=randomUUID();f.operation=await lab.requestProvisioning(f.admission,f.key);return f;
  };
  // Router state survives controller/worker recreation. A retired generation
  // rejects delayed commands; absence alone is never used as retirement proof.
  class FixtureNas {
    calls=0; probes=0; mode='ready'; records=new Map();
    async apply(command){
      this.calls++;const previous=this.records.get(command.serviceId);
      if(getNow()>=command.provisionalEndsBy)return 'not_applied';
      if(previous && (previous.command.generation>command.generation || previous.command.generation===command.generation && previous.retired))return 'not_applied';
      if(previous && previous.command.generation===command.generation)return 'accepted';
      if(this.mode==='reject')return 'not_applied';
      if(this.mode==='throw_before')throw new Error('fixture credential material must never be persisted');
      this.records.set(command.serviceId,{command:structuredClone(command),usableAt:this.mode==='pending'?null:getNow(),retired:false});
      if(this.mode==='lost_reply')throw new Error('timed out after applying');
      return 'accepted';
    }
    async inspect(command){
      this.probes++;const row=this.records.get(command.serviceId);if(!row)return null;
      const c=row.command;
      const identity={operationId:c.operationId,admissionId:c.admissionId,serviceId:c.serviceId,sessionKey:c.sessionKey,bindingVersion:c.bindingVersion,generation:c.generation,observedAt:getNow()};
      if(row.retired)return {...identity,state:'never_enabled',generationRetired:true,sessionClosed:true};
      return row.usableAt?{...identity,state:'ready',usableAt:row.usableAt,sessionEndsBy:c.provisionalEndsBy}:null;
    }
    retire(command){
      const row=this.records.get(command.serviceId);assert.ok(!row?.usableAt,'cannot erase previously usable access');
      this.records.set(command.serviceId,{command,usableAt:null,retired:true});
    }
  }
  setNow(new Date());const nas=new FixtureNas();
  const good=await fixture();assert.equal((await lab.requestProvisioning(good.admission,good.key)).id,good.operation.id);
  await denied(lab.requestProvisioning(good.admission,randomUUID()));
  await denied(lab.confirmReady(good.admission,good.session,3,getNow()));
  const work=await Promise.all(Array.from({length:6},()=>run(lab,nas,good.operation.id)));
  // Another worker may claim verification after apply commits, but only one
  // worker can ever claim/send the apply. Readiness remains a separate action.
  assert.equal(nas.calls,1);assert.ok(work.some(Boolean));
  if((await operation(good.operation.id)).state!=='confirmed')await run(lab,nas,good.operation.id);
  const effective=await period(good);assert.ok(effective.activation_at);assert.equal(effective.expires_at-effective.activation_at,86400000);
  assert.equal(await run(lab,nas,good.operation.id),false);assert.deepEqual(await period(good),effective);
  await lab.accounting(account(good,good.reply,'Stop',good.session));advance(2000);
  const reconnectReply=await lab.authenticate(request(good)),reconnectSession=randomUUID();
  await lab.accounting(account(good,reconnectReply,'Start',reconnectSession));
  const reconnectOp=await lab.requestProvisioning(reconnectReply['reply:Class'].slice(4),randomUUID());
  await run(lab,nas,reconnectOp.id);await run(lab,nas,reconnectOp.id);
  assert.equal((await operation(reconnectOp.id)).generation,2);assert.deepEqual(await period(good),effective);
  console.log('PASS: durable operation idempotency, concurrent worker leases, one apply and atomic effective-time confirmation');

  const ack=await fixture(),pending=new FixtureNas();pending.mode='pending';
  await run(lab,pending,ack.operation.id);assert.equal((await operation(ack.operation.id)).state,'verifying');assert.equal((await period(ack)).activation_at,null);
  await run(lab,pending,ack.operation.id);assert.equal((await operation(ack.operation.id)).state,'uncertain');assert.equal(pending.calls,1);
  advance(6000);pending.records.get(ack.id).usableAt=getNow();await run(lab,pending,ack.operation.id);
  assert.equal((await period(ack)).activation_at.toISOString(),getNow().toISOString());

  const crashed=await fixture(),recoveredNas=new FixtureNas();
  const abandoned=await lab.claimProvisioning(crashed.operation.id);assert.equal(abandoned.action,'apply');await recoveredNas.apply(abandoned.command);
  const actualUsableAt=getNow();assert.equal((await period(crashed)).activation_at,null);advance(11000);
  const restarted=await PppoeLab.create(pool,schema,getNow);
  assert.ok((await restarted.pendingProvisioning()).includes(crashed.operation.id));
  await denied(restarted.pendingProvisioning(101));
  await run(restarted,recoveredNas,crashed.operation.id);assert.equal(recoveredNas.calls,1);
  assert.equal((await period(crashed)).activation_at.toISOString(),actualUsableAt.toISOString());
  await denied(lab.recordProvisioningApply(abandoned,'accepted'));
  console.log('PASS: command ACK alone consumes no time; delayed usability and crash-after-apply recover through probes without replay');

  const retry=await fixture(),rejecting=new FixtureNas();rejecting.mode='reject';
  await run(lab,rejecting,retry.operation.id);assert.equal((await operation(retry.operation.id)).state,'retry');
  assert.equal(await run(lab,rejecting,retry.operation.id),false);advance(2000);
  await run(lab,rejecting,retry.operation.id);advance(4000);await run(lab,rejecting,retry.operation.id);
  assert.equal(rejecting.calls,3);assert.equal((await operation(retry.operation.id)).state,'attention');assert.equal((await period(retry)).activation_at,null);
  const generations=(await pool.query("SELECT generation FROM pppoe_lab_operation_events WHERE operation_id=$1 AND code='apply_claimed' ORDER BY sequence",[retry.operation.id])).rows.map(r=>r.generation);
  assert.deepEqual(generations,[1,2,3]);

  const lost=await fixture(),uncertainNas=new FixtureNas();uncertainNas.mode='lost_reply';
  await run(lab,uncertainNas,lost.operation.id);assert.equal((await operation(lost.operation.id)).state,'uncertain');advance(1000);
  await run(lab,uncertainNas,lost.operation.id);assert.equal(uncertainNas.calls,1);assert.equal((await operation(lost.operation.id)).state,'confirmed');
  console.log('PASS: bounded retries only for definitely unexecuted commands; lost replies reconcile without duplicate apply');

  const absent=await fixture(),absenceNas=new FixtureNas();absenceNas.mode='throw_before';
  await run(lab,absenceNas,absent.operation.id);const unresolved=await operation(absent.operation.id);
  advance(1000);await run(lab,absenceNas,absent.operation.id);assert.equal(absenceNas.calls,1);await denied(lab.authenticate(request(absent)));
  await denied(lab.confirmNeverEnabled(absent.admission,true));
  const oldCommand={operationId:unresolved.id,admissionId:absent.admission,serviceId:absent.id,subscriptionId:absent.period,sessionKey:absent.session,bindingVersion:3,generation:unresolved.generation,provisionalEndsBy:(await pool.query('SELECT admission_deadline FROM pppoe_lab_admissions WHERE id=$1',[absent.admission])).rows[0].admission_deadline};
  absenceNas.retire(oldCommand);assert.equal(await absenceNas.apply(oldCommand),'not_applied');advance(5000);await run(lab,absenceNas,absent.operation.id);
  assert.equal((await operation(absent.operation.id)).result_code,'absence_safety_window_pending');advance(60000);
  await run(lab,absenceNas,absent.operation.id);assert.equal((await operation(absent.operation.id)).state,'never_enabled');
  assert.equal((await period(absent)).activation_at,null);assert.equal(await absenceNas.apply(oldCommand),'not_applied');
  const fresh=await lab.authenticate(request(absent));assert.notEqual(fresh['reply:Class'].slice(4),absent.admission);
  const freshSession=randomUUID();await lab.accounting(account(absent,fresh,'Start',freshSession));
  const freshOp=await lab.requestProvisioning(fresh['reply:Class'].slice(4),randomUUID());absenceNas.mode='ready';
  await run(lab,absenceNas,freshOp.id);await run(lab,absenceNas,freshOp.id);
  assert.equal((await operation(freshOp.id)).generation,2);assert.equal((await period(absent)).expires_at-(await period(absent)).activation_at,86400000);
  console.log('PASS: uncertain access holds capacity; fenced never-enabled proof permits rescheduling with full duration and blocks delayed old commands');

  const mismatch=await fixture(),proofNas=new FixtureNas();await run(lab,proofNas,mismatch.operation.id);
  let probe=await lab.claimProvisioning(mismatch.operation.id),proof=await proofNas.inspect(probe.command);
  await lab.recordProvisioningProbe(probe,{...proof,sessionKey:'other-session'});assert.equal((await operation(mismatch.operation.id)).result_code,'mismatched_evidence');
  assert.equal((await period(mismatch)).activation_at,null);advance(5000);
  probe=await lab.claimProvisioning(mismatch.operation.id);proof=await proofNas.inspect(probe.command);
  await lab.recordProvisioningProbe(probe,{...proof,sessionEndsBy:new Date(probe.command.provisionalEndsBy.getTime()+1000)});
  assert.equal((await operation(mismatch.operation.id)).result_code,'invalid_enforcement_evidence');advance(5000);
  probe=await lab.claimProvisioning(mismatch.operation.id);advance(11000);
  await denied(lab.recordProvisioningProbe(probe,await proofNas.inspect(probe.command)));await run(lab,proofNas,mismatch.operation.id);
  assert.equal((await operation(mismatch.operation.id)).state,'confirmed');

  const stale=await fixture();await pool.query("INSERT INTO billing_customer_controls(customer_id,desired_state,version,reason,actor) VALUES($1,'suspended',1,'Fixture','fixture')",[stale.customer]);
  const idleNas=new FixtureNas();assert.equal(await run(lab,idleNas,stale.operation.id),false);assert.equal(idleNas.calls,0);
  assert.equal((await operation(stale.operation.id)).result_code,'policy_or_deadline_changed');
  const disabled=await fixture();await pool.query("INSERT INTO billing_customer_devices(id,customer_id,mac,label,enabled) VALUES($1,$2,'02:00:00:00:00:01','Fixture',false)",[randomUUID(),disabled.customer]);
  assert.equal(await run(lab,idleNas,disabled.operation.id),false);assert.equal(idleNas.calls,0);
  const quotaPackage=(await pool.query("INSERT INTO billing_packages(name,amount_minor,duration_value,duration_unit,download_bps,upload_bps,allowance_bytes,service_types) VALUES('Quota fixture',1000,1,'day',5000000,2000000,100,ARRAY['pppoe']) RETURNING id")).rows[0].id;
  const quota=await fixture('free',{packageId:quotaPackage});
  await lab.accounting(account(quota,quota.reply,'Interim-Update',quota.session,{'Acct-Input-Octets':{value:[100]}}));
  assert.equal(await run(lab,idleNas,quota.operation.id),false);assert.equal(idleNas.calls,0);
  assert.equal((await operation(quota.operation.id)).state,'attention');
  const late=await fixture();advance(40000);assert.equal(await run(lab,idleNas,late.operation.id),false);assert.equal(idleNas.calls,0);
  console.log('PASS: mismatched/overlong proof and stale leases cannot confirm access; changed policy or expired admission prevents apply');

  setNow(new Date());const rollback=await fixture(),rollbackNas=new FixtureNas();await run(lab,rollbackNas,rollback.operation.id);
  // Inject a failure after updating shadow times but before confirming the op.
  await pool.query("CREATE FUNCTION reject_fixture_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='confirmed' THEN RAISE EXCEPTION 'fixture crash before commit'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER reject_fixture_confirmation BEFORE UPDATE ON pppoe_lab_operations FOR EACH ROW EXECUTE FUNCTION reject_fixture_confirmation()');
  await assert.rejects(run(lab,rollbackNas,rollback.operation.id),/fixture crash before commit/);
  assert.equal((await period(rollback)).activation_at,null);
  await pool.query('DROP TRIGGER reject_fixture_confirmation ON pppoe_lab_operations');await pool.query('DROP FUNCTION reject_fixture_confirmation()');
  advance(11000);await run(lab,rollbackNas,rollback.operation.id);assert.equal(rollbackNas.calls,1);assert.equal((await operation(rollback.operation.id)).state,'confirmed');
  const history=JSON.stringify((await pool.query('SELECT * FROM pppoe_lab_operation_events')).rows);
  assert.ok(!history.includes('credential material'));assert.equal((await pool.query('SELECT count(*)::int n FROM billing_subscriptions WHERE activation_at IS NOT NULL')).rows[0].n,0);
  console.log('PASS: confirmation transaction rollback is recoverable; sanitized durable audit and production activation guards remain intact');
};
