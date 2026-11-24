import { runPppoeProvisioningBatch, runPppoeProvisioningOnce, type PppoeProvisioningAdapter, type PppoeProvisioningClaim, type PppoeProvisioningStore } from '../../modules/billing/pppoeProvisioning';

function fixture(action: 'apply' | 'probe'='apply') {
  const claim: PppoeProvisioningClaim={token:'worker-token',action,command:{operationId:'operation',admissionId:'admission',serviceId:'service',subscriptionId:'period',sessionKey:'session',bindingVersion:3,generation:1,provisionalEndsBy:new Date()}};
  const store: jest.Mocked<PppoeProvisioningStore>={pendingProvisioning:jest.fn().mockResolvedValue(['operation']),claimProvisioning:jest.fn().mockResolvedValue(claim),recordProvisioningApply:jest.fn().mockResolvedValue(undefined),recordProvisioningProbe:jest.fn().mockResolvedValue(undefined)};
  const adapter: jest.Mocked<PppoeProvisioningAdapter>={apply:jest.fn().mockResolvedValue('accepted'),inspect:jest.fn().mockResolvedValue(null)};
  return {claim,store,adapter};
}

test('an unclaimed operation never reaches the router',async()=>{
  const {store,adapter}=fixture();store.claimProvisioning.mockResolvedValue(null);
  expect(await runPppoeProvisioningOnce(store,adapter,'operation')).toBe(false);
  expect(adapter.apply).not.toHaveBeenCalled();expect(adapter.inspect).not.toHaveBeenCalled();
});

test('an apply timeout records only an uncertain result and does not resend',async()=>{
  const {claim,store,adapter}=fixture();adapter.apply.mockRejectedValue(new Error('timeout with private router details'));
  await runPppoeProvisioningOnce(store,adapter,'operation');
  expect(adapter.apply).toHaveBeenCalledTimes(1);expect(adapter.inspect).not.toHaveBeenCalled();
  expect(store.recordProvisioningApply).toHaveBeenCalledWith(claim,'unknown');
});

test('accepted commands require a separate readiness action',async()=>{
  const {claim,store,adapter}=fixture();await runPppoeProvisioningOnce(store,adapter,'operation');
  expect(store.recordProvisioningApply).toHaveBeenCalledWith(claim,'accepted');
  expect(store.recordProvisioningProbe).not.toHaveBeenCalled();expect(adapter.inspect).not.toHaveBeenCalled();
});

test('a failed probe remains unknown without replaying a router command',async()=>{
  const {claim,store,adapter}=fixture('probe');adapter.inspect.mockRejectedValue(new Error('private transport error'));
  await runPppoeProvisioningOnce(store,adapter,'operation');
  expect(store.recordProvisioningProbe).toHaveBeenCalledWith(claim,null);expect(adapter.apply).not.toHaveBeenCalled();
});

test('database commit failures propagate instead of being recorded as router failure',async()=>{
  const {store,adapter}=fixture();store.recordProvisioningApply.mockRejectedValue(new Error('database unavailable'));
  await expect(runPppoeProvisioningOnce(store,adapter,'operation')).rejects.toThrow('database unavailable');
  expect(store.recordProvisioningApply).toHaveBeenCalledTimes(1);expect(adapter.apply).toHaveBeenCalledTimes(1);
});

test('a new scheduler discovers pending work from durable storage',async()=>{
  const {store,adapter}=fixture();expect(await runPppoeProvisioningBatch(store,adapter)).toBe(1);
  expect(store.pendingProvisioning).toHaveBeenCalledTimes(1);expect(store.claimProvisioning).toHaveBeenCalledWith('operation');
});
