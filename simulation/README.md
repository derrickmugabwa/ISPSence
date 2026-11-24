# Billing flow simulation

This runnable initial purchase slice exercises checkout, payment verification, payment allocation, provisioning and expiry without hardware or provider credentials. It is separate from the MikroTik Manager dashboard and makes no network requests. No packages need to be installed; it uses the host's Node.js standard library.

From the project folder:

```powershell
node simulation/demo.mjs
node --test simulation/billing.test.mjs
```

Equivalent commands are `npm.cmd run demo:billing` and `npm.cmd run test:billing` on Windows.

## Implemented behavior

- Snapshot commercial terms and use integer KES minor units.
- Keep customer identity separate from the payment account/channel.
- Preserve separate payment attempts and prevent resubmission while an initiation result is uncertain.
- Verify a notification against the fake provider's record; caller-supplied success flags do not authorize access.
- Match amount, currency, merchant account, channel and attempt correlation.
- Allocate one payment per order and create one pending period and provisioning operation together. Retain excess/mismatched payments for review.
- Deduplicate receipts and reject conflicting reuse. Converge concurrent notifications and provisioning calls within the single simulated process.
- Leave effective access times unset before readiness. Reconcile a lost router reply using the original operation marker and timestamps.
- Model expiry independent of the application clock's processing schedule; ignore stale expiry revisions.

The demonstration buys an hour for KES 10, waits through an outage, loses an activation reply, recovers the original access period and expires it. Exactly one simulated router grant is applied. Times printed are deterministic UTC fixture times, not live operational timestamps.

## Storage and evidence limitations

`MemoryStore` serializes and atomically replaces cloned state in one process. It is not the candidate PostgreSQL schema or a persistent repository. The reconstruction test explicitly copies a snapshot to another store while retaining the fake provider/router objects; it does not prove disk persistence, actual process-crash recovery, multi-process locking or live router fencing.

The in-memory outbox models pending durable work conceptually; it has no broker publisher or PostgreSQL durability. The production implementation must replace these storage/dispatch boundaries, use explicit transition guards and financial permissions, and coordinate worker leases and router operations.

The fake router is programmed to retain operation evidence and enforce absolute expiry. These are the behaviors real adapters must demonstrate, not claims that any MikroTik model already meets them. The simulator is not a RouterOS or RADIUS emulator and does not test real reconnects, throughput, secure transport or hardware capabilities.

Renewals, replacement/forfeiture, capped usage, calendar-month calculation, device enrollment, customer login, manual payments, vouchers, refunds/reversals and unmatched unsolicited payments are not implemented here. Overlapping purchases on one customer's service are explicitly rejected until renewal rules are implemented. Customer identity/target identifiers are supplied by a test harness, not a public API; there is no authorization layer.

There is no PayHero API adapter. The fake provider's verification method is trusted only within tests. Delayed success without an established settlement time is routed to review. A real integration remains dependent on the account/API-family and authenticity checks recorded in `payhero_integration_assessment.md`.

## Validation result

On 14 October 2026, all 22 Node tests passed and the demo completed with one simulated grant. Source files in the upstream checkout and the running dashboard were not changed by this simulation work.

Next implementation boundary: introduce a PostgreSQL repository and transaction-backed inbox/outbox for this flow, preserving these behavior tests, before exposing it through authenticated administration routes. Production release gates and real-router tests still apply.
