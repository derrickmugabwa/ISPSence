# Billing domain and processing contract

Status: candidate design, 14 October 2026. The SQL alongside this document is a standalone validation model, not an installed migration. The current dashboard is still unmodified MikroTik Manager. Foundation, provider and real-router release gates remain open.

## Initial slice and integration boundaries

Start with packages, immutable checkout orders, verified payment allocation, purchased access periods and recoverable provisioning. Router enrollment, customer-facing screens, vouchers, cash/refunds administration and revenue reports use this core later. No payment credentials or hardware are required to exercise the draft constraints.

Reuse upstream `devices` as network inventory and existing staff authentication. `billing_draft.hotspots` references a device and one selected Hotspot service. Device deletion is restricted when billing depends on it. Customers are independent of network-observed clients and staff users; payer identity belongs to the payment attempt, not proof of customer ownership.

One subscription is an access relationship between a customer and a router/Hotspot. It contains multiple purchased periods over time, each funded by its own order. A renewal adds a period rather than changing the timestamps or terms of an already purchased period. Cross-router roaming is excluded from V1.

## Candidate records

| Record | Responsibility |
| --- | --- |
| customers | Subscriber identity; phone is contact information, not authentication. |
| hotspots | Upstream device and exact service binding; enabled only after readiness checks. |
| packages / package_hotspots | Editable offers and where they are sold. |
| subscriptions | Customer/service relationship and entitlement revision. |
| orders | Frozen commercial terms, payment deadline and requested renewal behavior. |
| payment_attempts | Each provider request, account/channel, payer, API family and uncertain results. |
| payment_entries | Append-only verified collections, refunds and reversals. |
| payment_allocations | At most one exact-amount collection funds one order. Excess collections remain recorded. |
| access_periods | One purchased period per order, proposed/effective timestamps, allowance and replacement linkage. |
| provisioning_operations | Desired/observed access state, stable operation key, expected revision and retry status. |
| provider_inbox | Received notifications, deduplication and verification status; receipt is not fulfillment. |
| outbox | Durable committed work for at-least-once publication. |
| business_events | Append-only actor, action, reason and relevant business facts. |

Additional schema work before deployment: access credentials/device registrations, customer recovery, encrypted provider configuration, voucher issuance/redemption, cashier records, staff capabilities, durable worker leases, retry history, and usage/accounting evidence. The core is intentionally not represented as a complete V1 schema.

## Purchase terms and units

- Store money as integer minor units; KES 10 is 1000 minor units. Convert at the provider boundary. For an API accepting only whole KES, reject unsupported fractional amounts before checkout rather than round them.
- Store upload/download rates in bits per second and caps in bytes. Normalize RouterOS units/direction in the access adapter, with hardware verification later.
- Snapshot name, exact duration, speed, cap, device policy, timezone and start policy. Snapshot price/currency in typed order columns. Order terms cannot change after creation, including while payment is pending.
- Use UTC-aware effective timestamps and retain the purchase timezone for calendar calculations. Hour/day/week are elapsed durations. Candidate calendar-month rule: add months from each period's local start and clamp a missing day to that month's final day; calculate each subsequent period from its actual local start. Explain this behavior at checkout. Timezone changes do not alter purchased terms.
- Unlimited data uses NULL; zero is not a synonym for unlimited. V1 has one active device per subscription. The SQL fixes that limit to one until more devices are deliberately supported.
- Select renewals under a subscription lock. Queue each period after all previously purchased, noncancelled scheduled periods. If the queue changes before checkout confirmation, recalculate and require confirmation of the revised schedule.
- Immediate replacement requires consent captured with the immutable order. Existing queued future purchases remain preserved; V1 should hold this choice for review when a queue already exists, until rescheduling/refund behavior is explicitly designed.

## State ownership

Payment-attempt state describes request processing; financial entries describe confirmed movements and adjustments. Never overwrite a successful collection to erase it when refunded. Preserve a separate refund/reversal linked to the collection; service rules must verify original ownership, cumulative adjustment amounts and provider evidence.

Order states cover payment and fulfillment. `active` means its period is currently active; the proposed additional `fulfilled` state preserves that service was delivered after its period ends. A subscription may remain active through another order's period. `needs_review` can accompany unresolved late/excess payments via business events; do not lose the paid transaction while resolving the order.

An expired payment deadline does not prove failure. Compare trusted provider settlement evidence with the order deadline when available. If settlement time cannot be established, send delayed results to review. Notification arrival time alone is insufficient to decide whether the customer paid late.

Proposed times can move only if access is confirmed never enabled. Effective activation/expiry become immutable once access was usable. Replacement forfeiture changes status and records its effective end in a business event; it does not rewrite the originally purchased expiry.

## Verified payment to pending access

1. Create an order with a subscription/service binding and immutable terms; a provider attempt gets a separate correlation reference.
2. Initiate outside the database transaction. Persist returned references; on a timeout mark uncertainty and reconcile before another request. Callback receipt may race the initiation response, so store unmatched notifications durably for later correlation.
3. Verify via the selected provider contract. Match stored request/account/channel, expected amount/currency and the genuine final transaction. A spoofed callback must not select an arbitrary payment to fulfill.
4. In one PostgreSQL transaction, lock the order and subscription; insert the verified financial entry, allocation, pending/scheduled period, operation intent, outbox event and business event. For a duplicate receipt, verify that the existing row has identical ownership and values before treating it as a replay. A uniqueness conflict is not proof of equivalent contents.
5. On an excess/mismatched/late payment, preserve its financial entry and create a review event. Do not allocate or provision a second grant. On transaction rollback, none of the entitlement/outbox mutations survive.
6. Publish committed outbox work and mark publication after enqueue. A crash can cause republishing; workers converge through the stable operation key and durable state. Queue job IDs are an optimization, not the only financial deduplication boundary.

## Provisioning and simulation boundary

The access adapter exposes `inspect(target, operationKey)` and `apply(intent)`. The initial standalone simulator in `simulation/` now covers never-applied, ready and uncertain outcomes, failure before apply, loss of reply after apply, delayed readiness through retry, and stale expiry revisions. The full contract also needs confirmed-not-ready staging and production command fencing. This is not an implemented MikroTik or RADIUS service; see `simulation/README.md` for storage limitations and deferred flows.

Before an external command, persist desired state and serialize entitlement changes per subscription and device. A database revision prevents stale database updates but cannot by itself fence an already running router command. The real worker must coordinate durable leases, existing device-write locks, actual router operation markers and in-flight timeout recovery. No production guarantee is made until this protocol is tested against a router.

Do not hold the financial database transaction open across network calls. After applying, verify actual readiness/evidence and finalize the period with the same effective timestamps. If proven never applied, proposed times may move. If uncertain, inspect before replay; do not mint new time. Start readiness and absolute expiry must be enforceable without consuming time during failed provisioning.

For replacement, retain the old period until the new grant is effective. Then atomically finalize old forfeiture, replacement activation, revision and event inside the database. Router/database partial outcomes still require reconciliation. Scheduled capped periods need a verified boundary switch/counter reset, including during application downtime; local-user versus RADIUS feasibility remains a release gate.

Before expiry or suspension, re-read the current period and expected revision. A delayed job for an older period cannot revoke a newer entitlement. Reconcile the router after uncertain/disordered commands instead of trusting a stale success response.

## Validation and limitations

Run `scripts/check-billing-schema.ps1` from the project directory. It creates `billing_draft` and a fake device row inside a single transaction, tests the candidate constraints and rolls everything back. The fake row uses an explicit ID and never triggers a router request. No application inventory sequence is advanced.

The checks cover frozen terms, receipt uniqueness, outbox deduplication, no activation on payment alone, excess collection allocation rejection, wrong-order rejection, append-only financial history, rescheduling proposed times, preserving effective times, stale-revision rejection and explicit replacement consent.

These are sequential database contract checks, not a payment integration, concurrency stress test, worker implementation or proof of router expiry. The service must additionally validate package terms, payment authenticity, transitions, valid refund linkage, allowance accounting, scheduled-period ordering and financial permissions. Use a least-privilege application role and managed production migrations; this schema's triggers do not protect against a database administrator.

SQL choices were checked against PostgreSQL 15 documentation for [constraints](https://www.postgresql.org/docs/15/ddl-constraints.html), [partial indexes](https://www.postgresql.org/docs/15/indexes-partial.html) and [conflict handling](https://www.postgresql.org/docs/15/sql-insert.html).
