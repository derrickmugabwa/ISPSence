# PPPoE provisioning and recovery workflow

Date: 2026-10-17. Implemented in the disposable authentication lab. No production worker, authorization, migration, or router command is enabled by this stage.

## Scope

This stage wraps first-session readiness and reconnect confirmation in durable operations. It uses the existing saved service, funding period, RADIUS admission, correlated Start and separately proved usable-access time. The adapter is a fictional NAS used to inject failures. A RouterOS adapter still requires capability discovery, private transport and physical-router qualification.

The operation addresses one existing provisional session. It cannot create or reopen a PPP session. The NAS must enforce the original provisional deadline independently of worker availability. The workflow does not extend provisional access or infer that an accepted command proves Internet access.

## Durable states

| State | Meaning | Next action |
| --- | --- | --- |
| queued | Persisted request; no command sent | Claim and revalidate policy |
| applying | Apply claim committed before router I/O | Save result; probe after a crash |
| verifying | Command acknowledged or a reconciliation lease claimed | Inspect exact operation and session |
| uncertain | Timeout, unreachable NAS, missing or unusable evidence | Probe; never blindly resend |
| retry | Adapter guaranteed the command was never applied and cannot execute later | Retry after 2/4-second backoff with a new generation |
| confirmed | Usable-access proof and effective timestamps committed together | Terminal; preserve timestamps |
| never_enabled | Historical never-usable, closed-session and retired-generation proof verified after the safety window | Terminal; permit a fresh admission without consuming time |
| attention | Three definite failures, changed policy, stopped session or expired admission | Hold transition for operator resolution; no automatic apply |

A request key is bound to one admission, and an admission has one operation. Repeated requests return that operation. A partial unique index permits only one unresolved transition per service, including attention states. Customer/service/subscription/admission/operation locks serialize claims and confirmations. No transaction stays open across adapter I/O.

Workers claim ten-second leases with random tokens. Only the current token, action and generation can commit a result before lease expiry. A replacement worker recovers an expired applying/verifying lease by probing the same command, never by assuming it failed. Due work is discoverable from PostgreSQL after restart; no process-local queue is authoritative.

The service generation increments before each fresh apply. The adapter must persist operation markers and reject retired generations, stale sessions and expired deadlines. Worker leases fence database writes; they alone cannot prevent a delayed router command. The fictional adapter models the required device-side fence. A production adapter must demonstrate equivalent protection before it can be enabled.

## Policy and evidence

Before applying, recheck service/credential/binding revisions, explicit NAS enrollment, funding and revocation, controls, schedule, device restrictions, recorded allowance use and effective expiry. A changed or expired request enters attention without a router call. Evidence must identify the exact operation, admission, service, session, binding revision and generation and contain a fresh, nonfuture observation time.

Ready evidence includes historical usability time and a bounded session deadline. The existing timing validator rejects future, out-of-session, stale-binding and out-of-admission usability proofs. Delayed evidence retains when access actually became usable. First effective timestamps and operation confirmation commit in one transaction; a failure after writing times rolls both back. Reconnects preserve an already confirmed period's dates.

Unknown or currently absent access does not prove access was never usable. Releasing an uncertain first period requires an explicit historical never-enabled proof, a closed session, retirement of the generation so delayed apply cannot succeed, and expiration of the existing sixty-second admission safety lease. A period already effective cannot be reset this way. Direct lab readiness/absence helpers cannot bypass an admission owned by an operation.

The event table records state, fixed result code, generation, attempt count and time. Router errors and credentials are never stored in events. Stored operation data contains no raw password or CHAP proof. Adapter exceptions become unknown outcomes; database errors propagate so failed commits remain recoverable.

## Verification

Run `./scripts/run-pppoe-auth-lab.ps1` from the project root. It builds and runs the existing database/UDP fixture plus `scripts/check-pppoe-provisioning.cjs`. The helper models router state independently of worker instances and tests concurrency, backoff, lost replies, delayed forwarding, worker restarts, lease fencing, stale/mismatched evidence, never-enabled recovery, delayed old commands and confirmation rollback. Fixtures and operations live only in the disposable schema and are removed after the run.

`backend/src/routes/__tests__/pppoeProvisioning.test.ts` checks the worker boundary: no adapter call without a claim, no resend after timeout, separate acknowledgement/readiness, safe probe failures, commit-error propagation and durable work discovery.

Validation on 2026-10-17: backend build, targeted lint and all 330 tests across 14 billing/PPPoE/RADIUS suites passed. The real PostgreSQL recovery driver and existing FreeRADIUS PAP/CHAP UDP fixture also passed. Source encoding checks passed. This validates the durable controller protocol with fictional NAS evidence, not live RouterOS forwarding or device-side fencing.

## Remaining enforcement work

Production activation and dashboards are unchanged. This is the operation engine for first-session confirmation, not a live RouterOS provisioning implementation. Live disconnect/expiry, speed changes, schedules, pause/vacation, early-renewal replacement, production NAS fencing and operator-resolution controls remain separate adapters/transitions to implement and qualify. Existing early-renewal entitlements are untouched: no old period is forfeited by this workflow. Any replacement transition must preserve both periods and end the old entitlement only when the new access becomes effective.

See [authentication lab](pppoe-authentication-lab.md) and [implementation plan](pppoe-implementation-plan.md).
