# ISP Billing System — Implementation Plan

## 1. Goal
Build a self-hosted ISP billing system using MikroTik Manager as the starting point. First replace ISPMan for our own small ISP, then make the product easy to deploy for other small ISPs.

**Current service:** MikroTik Hotspot. **Later:** PPPoE.

## 2. Deployment approach
- Use **one application deployment and one database per ISP**, with a shared codebase.
- Start with our own ISP; do not build multi-tenant SaaS in V1.
- Fork MikroTik Manager, keep the original repository as `upstream`, and review upstream fixes selectively.
- Keep new billing code in clearly separated modules and minimize changes to existing network-management code.
- Confirm MikroTik Manager's actual features, APIs, architecture, and license before coding. Do not assume a feature exists until verified.
- Review AGPL-3.0 obligations before commercial distribution or offering a modified application over a network. Consider a commercial license if proprietary modifications become important.

## 3. V1 features

### A. ISP settings and router management
- Configure ISP name, logo, timezone, and contact details.
- Add and manage MikroTik routers using secure credentials.
- Show router connection status and basic monitoring using existing MikroTik Manager features where available.
- Support more than one router for our ISP. Each V1 subscription is bound to exactly one router and one Hotspot service; access does not roam between routers. Assess roaming needs during Phase 0.

### B. Hotspot packages
- Create packages with name, price (KES), duration, download/upload speed, and optional data limits.
- Enable or disable packages and choose which routers or Hotspots offer them.
- Support hourly, daily, weekly, and monthly packages.

### C. Captive portal
- When a customer joins Wi-Fi, display available packages.
- Customer chooses a package and enters a phone number.
- Trigger M-Pesa STK Push and display pending, successful, or failed payment status.
- After confirmed payment, log the customer in automatically where technically possible; otherwise provide a clear one-tap connection flow.
- Support returning customers and reconnecting active sessions; use secure session/device linking rather than trusting a MAC address alone.
- Ensure the payment page and required API endpoints are reachable before internet access is granted (MikroTik walled garden configuration).

### D. Payments — PayHero first
- Integrate PayHero for M-Pesa STK Push and verified payment callbacks.
- Configure the ISP's own PayHero account and collection/settlement destination (Till, Paybill, or bank where supported by the provider and account setup).
- Keep the payment provider behind a simple interface so another provider can be added later.
- Store payment attempts, provider reference, amount, phone, status, and timestamps.
- Prevent duplicate activations when callbacks are repeated.
- Handle cancelled, failed, delayed, and unmatched payments; add reconciliation and a manual review screen.
- Never grant access based only on a successful STK request: verify payment success first.

### E. Customers and subscriptions
- Keep customer phone number, basic details, purchased packages, and payment history.
- Create or renew access only after a verified payment or an authorized manual action.
- Apply the correct Hotspot user/profile, speed, and expiry settings to MikroTik.
- Automatically expire subscriptions, disconnect expired sessions, and block reconnection until renewal.
- Retry failed router actions safely and show staff any payments that succeeded but did not activate access.

### F. Vouchers and manual payments
- Generate and redeem prepaid Hotspot vouchers.
- Allow authorized staff to record cash payments and issue access.
- Generate unpredictable voucher codes using a cryptographically secure random generator. Store only a secure hash of the redeemable secret, never plaintext after issuance; protect printable/exported codes.
- Redeem each single-use voucher atomically with a database uniqueness/locking rule so concurrent requests cannot redeem it twice.
- Track issuance, redemption, expiration, revocation, staff actions, and the resulting access grant. Revocation prevents unused codes from being redeemed; revoking an already redeemed voucher requires an explicit, audited access decision.

### G. Dashboard and reports
- Show revenue by day/month, successful and failed payments, active subscriptions, and expiring packages.
- View payment history and export basic reports.
- Record important admin actions such as manual activation, voucher creation, and payment corrections.

## 4. Key workflow
1. Customer joins Wi-Fi and sees the Hotspot portal.
2. Customer selects a package and enters a phone number.
3. Billing system creates a pending order and requests PayHero STK Push.
4. PayHero reports the result; backend verifies the payment and matches it to the order.
5. Billing system records the paid order and queues an idempotent MikroTik provisioning request; paid time does not start yet.
6. After verified provisioning, billing starts the purchased time and allows customer login; if provisioning is uncertain, reconcile actual router state first.
7. At expiry, the system disconnects the session and blocks further access until renewal.
8. If payment succeeds but router activation fails, the order remains paid and a retry/alert is created; the customer is not charged again. If service cannot be delivered within the agreed time, offer refund or manual resolution.

## 5. Suggested data records
- **ISPs/settings** — configuration for the single ISP in each deployment.
- **Routers / Hotspots** — managed devices and Hotspot services.
- **Customers** — subscriber details.
- **Packages** — pricing, duration, speed, and limits.
- **Orders** — package purchases awaiting or completing payment.
- **Payments** — PayHero transactions and manual payments.
- **Subscriptions** — active and expired access periods.
- **Access accounts / sessions** — MikroTik identifiers and connection state.
- **Vouchers** — generated codes and redemption records.
- **Network jobs** — activation, renewal, suspension, retry status.
- **Activity logs** — important staff and system actions.

Adapt these to the existing MikroTik Manager schema after inspecting it; do not duplicate existing tables without a reason.

## 6. Technical approach
- Reuse MikroTik Manager's existing frontend, backend, database, router connections, and monitoring where suitable.
- Implement billing as separate backend services/modules with their own routes and UI pages.
- Use a background job queue for router operations, payment follow-up, and expiry processing.
- Make payment and activation processing safe to retry.
- Keep router credentials encrypted and restrict access to router management ports through VPN/private networks where possible.
- Protect payment callbacks with the provider's supported verification mechanism; never trust callback content without checking authenticity and transaction details.
- Use HTTPS, role-based permissions, backups, and audit logs.

## 7. Migration from ISPMan
1. Document current packages, prices, login experience, router settings, and active subscriber behavior.
2. Identify whether ISPMan uses local MikroTik Hotspot users or RADIUS; inspect actual configuration.
3. Export supported customer/package/payment records where possible.
4. Set up a separate test router or isolated Hotspot and test the full payment-to-access flow.
5. Run the new billing system alongside ISPMan for testing, but **do not let both systems manage the same live subscribers**.
6. Test expiry, reconnects, failed payments, delayed callbacks, router outages, and duplicate callbacks.
7. Plan cutover, backup router configuration, and prepare a rollback path.
8. Move live traffic only after successful end-to-end testing; keep ISPMan available until stability is confirmed.

## 9. Explicitly out of scope for V1
- Multi-tenant SaaS and a central ISP billing wallet.
- Invoicing ISPs for platform traffic (ISPMan's business model).
- Complex accounting and reseller commissions.
- Customer prepaid wallet unless real demand emerges.
- Full PPPoE implementation before Hotspot is stable.

## 10. Definition of success
- A customer can connect to Wi-Fi, select a package, pay through M-Pesa, and get access without staff intervention.
- Access uses the correct speed and automatically expires.
- Repeated callbacks never create duplicate access or payments.
- Paid-but-not-activated cases are visible and recoverable.
- Staff can manage packages, vouchers, customers, payments, and reports.
- The system can safely replace ISPMan for our own ISP and later be deployed separately for another ISP.

## 11. First action
**Do not start building modules yet.** Review MikroTik Manager's actual source code and our current ISPMan/router configuration, then create a short gap analysis showing what exists, what must be added, and which existing code needs changes.


## 12. Package and subscription rules (required before coding)
- **Start time:** A purchased package starts when router provisioning is confirmed successful and access is ready. Payment time alone does not start the clock. A first-login-start voucher is a separate product type and must have a defined redemption deadline.
- **Provisioning delay:** Paid orders remain `paid_awaiting_activation` until access is confirmed. Show this clearly and alert staff if delayed. Do not silently consume paid time.
- **Durations:** Store exact duration units. An hour means 60 minutes; a day means 24 hours; a week means 7 days. A calendar-month package ends at the corresponding local date/time next month, with an explicit last-day-of-month rule; do not silently treat it as 30 days. At checkout show the purchased duration and an **estimated** expiry for new/inactive purchases; confirm exact expiry after activation. For active renewals with an established end time, show the calculated exact new expiry, subject to any explicit immediate-start choice.
- **Renewals:** If the same package is renewed while active, add its duration to the existing expiry. If expired, begin a new period after provisioning. Do not shorten an existing subscription when processing older jobs.
- **Package changes:** V1 does not allow an immediate change of speed or package on an active subscription. Allow scheduling a new package after the existing period expires; refund/manual override requires staff approval and an audit entry.
- **Allowances and early renewal:** For capped packages, track the allowance separately for each purchased period and reset counters at the start of that period. If the current allowance is exhausted, access remains blocked until the next scheduled period. At checkout offer an explicit alternative: **start the newly purchased period immediately**, forfeiting all remaining time and unused allowance from the current period; show this warning and require confirmation. Serialize changes per subscription and perform the switch as a recoverable provisioning transition, preserving both current and replacement period records. Forfeit the old entitlement and finalize the replacement allowance only when the replacement becomes effective. If the router update is confirmed not applied, retain the current entitlement and retry or cancel the replacement. If the outcome is uncertain, reconcile actual router state before further changes, duplicate grants, counter resets, or forfeiture. Database updates and router commands are not one atomic transaction. Never silently restart or extend a depleted allowance. Unlimited packages have no data cap.
- **Devices:** Default to one active device per subscription. Define device registration and controlled device replacement; do not assume MAC address alone proves ownership. The checkout must show the device policy.

## 13. Reliable router enforcement and outage recovery
- Verify whether the chosen RouterOS Hotspot setup can enforce the required absolute expiry, session timeout, and data/speed limits locally. A scheduler-only disconnect is **not sufficient** if the billing app is down.
- If a rule cannot be enforced on the router, do not claim guaranteed expiry during an outage. Choose and document a tested alternative (for example RADIUS authorization/accounting) before production.
- Persist proposed activation/expiry timestamps separately from effective `activation_at` and `expires_at`, alongside a stable provisioning operation ID for each purchased access period. Proposed timestamps reserve intended configuration and do not consume paid time. Effective timestamps represent when access actually became usable and the corresponding purchased expiry; retain verifiable router-side evidence where access can precede database confirmation. If access was confirmed never enabled, reschedule proposed timestamps without consuming the purchased duration. Once access has become usable, retries and reconciliation must preserve its effective timestamps and never restart the clock. If access may have become usable but its original activation time cannot be established, place the provisioning operation in `uncertain` state, restrict further duplicate grants, and resolve from reliable router evidence or an audited staff decision. Do not silently give a fresh full duration.
- Persist intended router state and actual last-observed state. On reconnection or restart, compare router accounts, profiles, active sessions, and limits against current subscriptions and correct differences.
- On expiry, first re-read the latest subscription and expiry under a lock; never let a delayed job disconnect a customer whose subscription was renewed.
- Test application downtime, job-worker downtime, router unreachable, router restart, delayed provisioning, and recovery. Record the maximum tolerated enforcement delay.

## 14. Orders, payments, and provisioning: state and retry rules
- **Order states:** `pending_payment`, `paid_awaiting_activation`, `active`, `expired_unpaid`, `needs_review`, `refunded`.
- **Payment-attempt states:** `initiated`, `pending`, `succeeded`, `failed`, `reversed`, `refunded`. Keep every attempt, including failures; never overwrite original provider responses.
- **Subscription states:** `pending_activation`, `active`, `expired`, `suspended`, `cancelled`.
- **Provisioning states:** `queued`, `in_progress`, `confirmed`, `retry_pending`, `uncertain`, `failed`.
- Each order has a unique internal reference. Each provider transaction ID is unique per provider. Each provisioning operation has a stable idempotency key. Enforce uniqueness in the database, not only in application code.
- Verify payment amount, currency, merchant destination, order reference, and final provider status. Use a database transaction to record a successful payment and durable provisioning-outbox event together; workers process the outbox after commit.
- Multiple callbacks and concurrent workers must converge on one confirmed payment and one access grant. A second successful payment attempt for the same order is recorded as excess payment and sent to review/refund, not applied automatically.
- If a worker crashes after sending a router command, treat the result as uncertain and inspect actual router state before attempting again. Match the router account/operation marker to the persisted access period. Reuse confirmed effective `activation_at`/`expires_at`; reschedule proposed timestamps only when access is confirmed never enabled. Operations must be safe to repeat.
- Define and test the activation commit protocol before production: reserve a durable period with proposed timestamps, apply an idempotent router configuration, verify when access became usable, and finalize effective activation/expiry timestamps without consuming time before readiness. If first usable access can precede database confirmation, record verifiable router-side evidence or flag uncertain results for reconciliation. Serialize all entitlement-changing operations per subscription, including early renewal, and preserve current and replacement records until the replacement outcome is resolved. Finalize forfeiture only when the replacement becomes effective.
- Never run router changes inside a payment database transaction. Log every retry and final outcome.

## 15. Customer access and abuse protection
- Keep payer phone number separate from subscriber/account owner; a parent or friend may pay for someone else.
- Phone-number entry alone never grants access to an existing subscription. Use verified login/OTP or an equivalent secure recovery method for account ownership and device replacement.
- For known devices, issue a revocable, time-limited session/credential after secure registration. MAC addresses can help identify sessions but are not sufficient authentication by themselves.
- Support secure recovery on a new device and invalidate replaced-device access where the package allows only one device.
- Rate-limit STK Push initiation, payment status polling, OTP/login attempts, and voucher redemption. Add cooldowns and abuse monitoring without blocking legitimate retries unnecessarily.

## 16. Frozen purchase terms and payment exceptions
- At checkout, copy package name, price, KES currency, duration/unit, upload/download speed, data allowance, device limit, and expiry/start policy into the order. Later package edits must not change the purchase.
- Each order has a payment deadline. A successful late payment must be recorded but must not silently activate an expired order; send it to a documented review, fulfillment, or refund flow.
- Amount mismatches and unmatched transactions go to review; do not grant access automatically.
- Payment reversals and refunds must preserve the original transaction, create separate audit entries, and trigger an explicit access-review policy rather than deleting history.
- If paid service cannot be provisioned within the stated service window, notify staff and customer, and provide an authorized refund or resolution path. Keep a reconciliation screen for provider-versus-system differences.

## 17. Operational readiness before live cutover
- Before Phase 3, provide reproducible deployment steps, tested database backup **and restore**, router configuration backup, encryption-key/secret recovery plan, and tested rollback for app and database migrations.
- Monitor web app, payment callbacks, queue workers, scheduler, router connectivity, and pending paid activations; alert on stuck jobs and missed expiries.
- Cutover must preserve orders, payments, and subscriptions created after migration. Maintain a transaction export/reconciliation log and a defined rollback ownership process: ISPMan must not be restarted against conflicting live accounts without reconciling new activity first.
- Perform a rehearsed cutover and rollback on a test router. Confirm active users, paid time, payment records, and router access survive the exercise.

## 18. Phase 0 deliverables and exit criteria
Phase 0 is complete only after documenting:
1. Exact upstream repository URL, pinned commit/tag, verified license text, and dependency review.
2. Reuse-versus-build matrix for Hotspot users, profiles, vouchers, session limits, router API, authentication, and monitoring.
3. Confirmed ISPMan topology: local MikroTik Hotspot users versus RADIUS, plus configuration ownership and safe coexistence plan.
4. PayHero API verification: payment initiation, authenticity/status checks, callbacks, reference matching, settlement method, fees, and reversal behavior.
5. Captive portal test: package page and payment/status endpoints work from an unauthenticated Hotspot client through correctly restricted walled-garden access.
6. Tested plan for local expiry enforcement and outage recovery, or a documented alternative if RouterOS cannot satisfy it.
7. Written **go/no-go decision** on MikroTik Manager as the foundation, with reasons and key risks.
8. Confirm whether cross-router roaming is needed. V1 assumes **one subscription = one router + one Hotspot**; if roaming is essential, design and validate centralized authentication/accounting before proceeding.

## 19. Development phases and release gates (authoritative sequence)
This is the **only** phase plan; all other sections describe requirements, not an alternative schedule. A phase is complete only when its gate passes.

### Phase 0 — Foundation decision
- Complete all deliverables in Section 18, including the local-Hotspot-versus-RADIUS decision, PayHero verification, portal reachability, router enforcement test, and roaming assessment.
- **Gate:** Written go/no-go decision, pinned source revision, and approved architecture. Do not modify the foundation before this decision.

### Phase 1 — Working test purchase
- Implement package/order records, portal, PayHero payment verification, durable provisioning, and one-router Hotspot activation.
- Demonstrate one successful purchase with correct frozen terms, an estimated expiry at checkout, and an exact persisted expiry after access readiness is verified.
- **Gate:** Paid test order provisions exactly once; retries preserve the same activation/expiry timestamps.

### Phase 2 — Production safety and operations
- Implement Sections 12–17: renewals, capped-package exhaustion choices, expiry enforcement, outage reconciliation, payment exceptions, account recovery, vouchers, staff permissions, and reports.
- Test app/worker downtime, router restart, crash after router command, duplicate callbacks, simultaneous voucher redemption, and renewed accounts with delayed expiry jobs.
- Complete monitored deployment, database-and-key restore, upgrade recovery, and a rehearsed rollback that preserves post-cutover transactions.
- **Gate:** All critical tests and restore/rollback rehearsal pass before live traffic moves.

### Phase 3 — Controlled ISPMan replacement
- Migrate and reconcile supported records; switch one controlled Hotspot group, then the remaining customers after observation.
- Ensure only one system controls any given subscriber; reconcile every new payment and access grant if rolling back.
- **Gate:** End-to-end live purchase, expiry, reconnection, reconciliation, and rollback readiness are confirmed.

### Phase 4 — Other small ISPs
- Add branding, first-run setup, repeatable Docker deployment, documented upgrades, and support guidance.
- Keep a single codebase with a separate deployment, database, and payment credentials per ISP.

### Phase 5 — PPPoE
- Add a PPPoE provisioning adapter while reusing billing rules. Evaluate local PPPoE versus FreeRADIUS based on real operational needs.

## 20. Guided dashboard router onboarding (V1 requirement)

- Staff can choose **Add MikroTik** in the dashboard and complete a guided connection and setup flow. Routine onboarding should not require manually assembling router commands or editing application configuration files.
- Support a broad range of MikroTik models through verified RouterOS capabilities, installed packages and available resources. Do not promise every model/version works; publish a tested compatibility matrix and explain unsupported capabilities during onboarding.
- Offer two starting points: **connect an existing router** or **set up a new/test router**. Connecting an existing router first performs read-only discovery and does not change live network configuration.
- Guide staff through a secure reachable management address or private tunnel, credentials and connection test. If initial router access requires a bootstrap step, provide a short, scoped, explained setup procedure or a single-use, short-lived enrollment mechanism. Do not assume discovery can reach routers behind NAT or on another network.
- Discover router identity, model, RouterOS version, relevant features, Hotspot services, interfaces and existing authentication settings. Detect existing RADIUS configuration without exposing its shared secrets. Present compatibility and connection failures in plain language with a clear next action.
- Separate **connected for monitoring** from **ready for billing**. Let staff select the intended Hotspot service, packages and portal settings; show exactly which service and network the billing setup will affect.
- Show a change preview before applying configuration. Back up relevant configuration and use tested change protection where supported. Do not overwrite existing ISPMan/RADIUS ownership or factory-reset a router as part of routine onboarding. Existing-provider migration follows the controlled cutover process.
- Apply only the chosen configuration using resumable, idempotent onboarding operations. Persist progress and uncertain outcomes so reopening the dashboard or retrying cannot duplicate services, accounts or network rules. Integrate with device-write coordination and reconciliation.
- Validate secure connectivity, selected authentication backend, restricted portal reachability, access provisioning and expiry enforcement on an isolated test account before marking the service ready for billing. Show completed checks and any remaining blockers in the dashboard.
- Acceptance tests cover an existing live router in read-only discovery, a new/test router setup, unreachable/NAT-isolated devices, unsupported features, incorrect credentials, interrupted setup, retry after uncertain results, and an existing RADIUS-managed Hotspot. Failed onboarding must leave existing service intact or report a recoverable partial configuration explicitly.
- Phase 0 must assess reuse of upstream device addition/adoption and guest-network setup against this flow. Phase 1 may use a manually prepared test router; guided onboarding is required before the Phase 2 production gate. Phase 4 improves packaging and first-run installation rather than deferring router onboarding.
- Current deployment note: the owner believes ISPMan uses RADIUS; this remains unverified. Keep RADIUS integration and migration assessment in Phase 0, separate from assumptions about future router models.
