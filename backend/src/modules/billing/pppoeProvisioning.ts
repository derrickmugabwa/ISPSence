/** Durable lab worker contract. No production scheduler or router imports it. */
export interface PppoeProvisioningCommand {
  operationId: string;
  admissionId: string;
  serviceId: string;
  subscriptionId: string;
  sessionKey: string;
  bindingVersion: number;
  generation: number;
  provisionalEndsBy: Date;
}
export interface PppoeProvisioningClaim {
  token: string;
  action: 'apply' | 'probe';
  command: PppoeProvisioningCommand;
}
export type PppoeApplyResult = 'accepted' | 'not_applied' | 'unknown';
export type PppoeProvisioningEvidence = {
  operationId: string;
  admissionId: string;
  serviceId: string;
  sessionKey: string;
  bindingVersion: number;
  generation: number;
  observedAt: Date;
} & (
  { state: 'ready'; usableAt: Date; sessionEndsBy: Date } |
  // This attests the entire attempt was never usable, its session is closed,
  // and this generation is retired: a delayed apply cannot take effect later.
  { state: 'never_enabled'; generationRetired: true; sessionClosed: true }
);
export interface PppoeProvisioningAdapter {
  // Address only this existing provisional session: never reopen/create one.
  // Enforce provisionalEndsBy on the NAS even if the controller disappears.
  // Retired generations and commands past that deadline must be rejected.
  apply(command: PppoeProvisioningCommand): Promise<PppoeApplyResult>;
  inspect(command: PppoeProvisioningCommand): Promise<PppoeProvisioningEvidence | null>;
}
export interface PppoeProvisioningStore {
  pendingProvisioning(limit?: number): Promise<string[]>;
  claimProvisioning(operationId: string): Promise<PppoeProvisioningClaim | null>;
  recordProvisioningApply(claim: PppoeProvisioningClaim,result: PppoeApplyResult): Promise<void>;
  recordProvisioningProbe(claim: PppoeProvisioningClaim,evidence: PppoeProvisioningEvidence | null): Promise<void>;
}

/** A scheduler can rediscover durable work after a process restart. */
export async function runPppoeProvisioningBatch(store: PppoeProvisioningStore,adapter: PppoeProvisioningAdapter): Promise<number> {
  let processed=0;
  for (const id of await store.pendingProvisioning()) if (await runPppoeProvisioningOnce(store,adapter,id)) processed++;
  return processed;
}

// One durable action per invocation. Router I/O never holds a DB transaction.
// The adapter must enforce its own I/O deadline and persistent generation fence.
// A thrown error is uncertain, including a timeout; raw errors are never stored.
export async function runPppoeProvisioningOnce(store: PppoeProvisioningStore,adapter: PppoeProvisioningAdapter,operationId: string): Promise<boolean> {
  const claim=await store.claimProvisioning(operationId);
  if (!claim) return false;
  if (claim.action==='apply') {
    let result: PppoeApplyResult;
    try { result=await adapter.apply(claim.command); } catch { result='unknown'; }
    await store.recordProvisioningApply(claim,result);
  } else {
    let evidence: PppoeProvisioningEvidence | null;
    try { evidence=await adapter.inspect(claim.command); } catch { evidence=null; }
    await store.recordProvisioningProbe(claim,evidence);
  }
  return true;
}
