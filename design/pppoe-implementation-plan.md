# PPPoE implementation plan

Date: 2026-10-16. Status: implementation started; no live router changes authorized by this document.

Foundation slices: persistent draft-service API, package eligibility storage, transactional legacy mapping, encrypted one-time credential creation/reset, and customer Access-tab controls are implemented; see [the API and migration contract](pppoe-foundation-contract.md). Package eligibility UI, compatible funding selection and prepared entitlement assignment are also implemented; see [package funding](pppoe-package-funding.md). Effective router provisioning, production RADIUS acceptance and effective live activation remain gated.

Read-only router discovery, pending router assignments and a separate PAP/CHAP protocol fixture are implemented and validated; see [router assignment and protocol fixture](pppoe-router-binding.md) for validation status and remaining gates. Pending assignments are not enrolled NAS devices or effective configuration. Production RADIUS acceptance and live activation remain disabled.

The database-backed authentication lab now has a [durable provisioning and recovery workflow](pppoe-provisioning-recovery.md) for first-session confirmation: leased operations, fencing generations, safe retries, uncertain-result reconciliation and atomic shadow activation. Its fictional adapter validates recovery behavior while hardware is unavailable; production enforcement and router onboarding remain pending.

## Goal and scope

Add PPPoE for home and business customers while PayHero credentials are pending. Customers connect using a username and password configured on their own router/CPE. Reuse Customers, Packages, Payments, Subscriptions, access controls, and reporting. PPPoE does not depend on the captive portal or a successful PayHero test.

Use FreeRADIUS for centralized authentication and accounting, with MikroTik providing PPPoE termination and enforcement. Reuse the existing private RADIUS bridge instead of building a second billing system. Support routers by detected RouterOS capabilities and tested versions, rather than limiting support to the RB951 or promising every model works identically.

This moves PPPoE development forward from the original plan's Phase 5 at the owner's request. It does not remove the live provisioning, migration, or payment verification release gates in that plan. Hotspot must continue to work during these changes.

### Initial release

- Persistent PPPoE accounts and credential reset.
- Select a customer, compatible package, router/service, and IP pool; optional CPE MAC binding.
- Manual payment receipts and complimentary grants using existing billing rules.
- Renewals using the same PPPoE username and password.
- Package speeds, customer speed override/reset, expiry, suspend/resume, schedules, and pause/vacation.
- Session details, usage, disconnect, provisioning outcomes, and audit history.
- Dashboard router onboarding with a generated setup script, change preview, and connection checks.
- Isolated protocol tests before real hardware is available.

Defer automatic recurring collections, credit/postpaid invoicing, IPv6 delegation, burst/CIR tuning, complex multi-router roaming, bulk ISPMan migration, and a separate subscriber self-service portal. Start with router-managed IPv4 pools; reserve a model for static addresses but add their UI only when address reservation/conflict handling is implemented.

## 1. What exists and what must change

| Area | Existing behavior | PPPoE work |
| --- | --- | --- |
| Customer and billing | Permanent customer numbers, package snapshots, payments, subscriptions, complimentary grants | Add service eligibility and explicit selection of the PPPoE service being renewed |
| Access accounts | One generated account per subscription; Hotspot-specific router fields; credentials prohibited by schema | Introduce a persistent customer service/login and an entitlement linkage |
| RADIUS | Private FreeRADIUS accounting lab; authentication deliberately rejects | Separate test and production authorization, enroll NAS devices, implement supported password authentication |
| Accounting | Durable duplicate-safe diagnostic records, not customer-linked | Bind trusted sessions to service, entitlement, and authorization attempt |
| Access controls | Real requests remain pending; simulator confirms test outcomes | Implement a recoverable live RADIUS/router adapter |
| Dashboard | Customer profile, access account and session views | Add PPPoE details and actions in the existing UI |

Relevant starting files: `backend/src/modules/billing/subscriptions.ts`, `paymentReceipts.ts`, `customerAccess.ts`, `accessPolicy.ts`, `accessManagement.ts`, `accessReconciliation.ts`, `sessions.ts`, `radiusAccounting.ts`, `backend/src/routes/radiusBridge.ts`, and `radius/`. Existing constraints intentionally forbid issuing credentials and activating live periods; replace those constraints through explicit migrations only when their new invariants are implemented.

## 2. Persistent customer services and credentials

Introduce a customer service separate from a purchased access period:

```text
Customer -> Customer service (PPPoE login) -> Entitlement assignments -> Subscription periods
                        |
                        +-> Router/service binding, credentials, sessions, provisioning history
```

The customer number identifies the customer; the PPPoE username identifies a connection. Keep them separate. Default to one PPPoE service per customer, while allowing the schema to represent multiple connections later.

Proposed records:

- `billing_customer_services`: customer, service type, unique normalized username, desired state, configuration revision, timestamps. Preserve the entered display form and define case/realm handling consistently before issuing credentials.
- `billing_service_bindings`: service, enrolled router/NAS, PPPoE service name, PPP profile/pool mapping, optional CPE MAC, version. One active binding per service in v1.
- `billing_service_credentials`: encrypted credential material, key identifier, credential revision, reset metadata. Never return secrets in list/detail responses.
- `billing_service_entitlements`: service, subscription, queued/current/historical assignment. Reject cross-customer links, conflicting active periods, and incompatible package/service types.
- `billing_radius_clients`: enrolled router identity, private source mapping, independently managed secret reference, enabled state and discovered capabilities.
- `billing_authorization_attempts` and admission reservations: request identity, policy revision, entitlement, bounded expiry, outcome, session correlation. No passwords or raw credential packets.

Keep old subscription/access-account IDs resolvable during migration. Backfill existing records as legacy Hotspot/prepared access; do not invent PPPoE credentials or reclassify historical sessions. Migrate session/report joins and creation paths deliberately; an unchecked nullable `subscription_id` change is insufficient.

Packages gain service eligibility, initially Hotspot, PPPoE, or both. A purchase/complimentary grant records the intended service and frozen terms. Renewal creates a new entitlement for the existing login, not another login. Preserve current payment history and prevent the same purchased entitlement from powering two connections accidentally.

Credential policy:

- Generate strong passwords server-side; offer one-time reveal/copy in an authorized modal. Lost passwords are reset, not retrieved through ordinary pages.
- Choose and document the initial authentication matrix. Target PAP and CHAP first; qualify MS-CHAPv2 separately if required by CPE compatibility. Do not enable MS-CHAPv1 by default.
- A normal website password hash cannot satisfy every PPP authentication method. Use method-compatible secret material encrypted at rest, with keys outside the database, scoped access, rotation, and tested database-plus-key restore.
- Verify credentials in the trusted RADIUS path; do not pass them to browser APIs, audit logs, traces, or diagnostics. Prefer a short-lived, opaque authorization context over returning cleartext secrets through the HTTP bridge.
- Reset invalidates old authentication material. Existing sessions are explicitly disconnected when reset is meant to revoke current access; show confirmation/pending outcomes accurately.

## 3. Authorization, billing time, and enforcement

One shared policy evaluator decides whether a login may connect, using customer/service state, trusted router binding, compatible funded entitlement, schedule, optional CPE binding, connection limits, and expiry. A valid password alone does not grant access.

Return an allowlisted reply derived from frozen package terms and current approved overrides: PPP framing, profile/pool mapping, speeds, interim accounting interval, and a bounded session lifetime. Unit-test upload/download direction from the customer's perspective. Do not use Hotspot-only attributes as PPP connection-limit enforcement.

### Activation and renewal rules

1. Payment confirmation or a complimentary grant prepares entitlement; it does not start paid time. Service setup, credential generation, and an Access-Accept alone also do not prove usable access.
2. Before authorization, persist an attempt/reservation with proposed timing and a short, bounded admission lifetime. Serialize customer, service, and subscription mutations in a documented order compatible with existing customer-first locking.
3. Correlate authentication to trusted NAS session evidence, preferably with an opaque RADIUS Class value verified in lab/router tests. Confirm readiness using NAS session state/accounting evidence and a verified service configuration. Accounting alone does not prove general Internet reachability; onboarding includes an end-to-end connectivity test.
4. Record effective activation from verified session/readiness evidence, preserving original timestamps on retries. If access was proven never enabled, release the reservation and reschedule without consuming the purchased duration.
5. A session may become usable before the accounting/database confirmation arrives. Explicitly handle that window: retain the earliest trustworthy start evidence, bound provisional access, and reconcile lost responses. Never convert an uncertain result into a fresh full-duration grant. The exact first-session handshake and outage behavior must be documented and tested before enabling live authorization.
6. An ordinary reconnect uses the current period's remaining time; it never restarts that period. Router-side session lifetime must not exceed the remaining entitlement or next schedule boundary. Check rounding and authorization-to-session-start delay; require a measured bound or a supported absolute deadline mechanism before claiming exact expiry during an app outage.
7. Queue renewals as separate preserved periods. V1 starts the next period after its predecessor ends and usable access is confirmed. Early replacement, if subsequently exposed, is a recoverable transition: retain the old entitlement until replacement is effective, then finalize forfeiture in the database. Resolve uncertain router results before retrying.

Suspend blocks admission and requests termination of current sessions; paid time continues. Schedules also continue the clock. Pause/vacation preserves remaining time only after confirmed disconnection, and resumes after confirmed readiness within allowed hours. Reuse immutable original timestamps and runtime-adjusted expiry.

For current-session speed changes, attempt only tested CoA behavior; otherwise show a reconnect-required change and use a confirmed disconnect/re-authentication workflow. Pool/profile changes that require reconnect must say so in the action preview.

New authorization fails closed when authoritative policy or required secrets are unavailable. Existing sessions retain their NAS-enforced deadline. Worker downtime cannot justify unbounded access. Define operational tolerances for delayed suspension/revocation when the NAS is unreachable, and show pending enforcement rather than applied success.

## 4. Session accounting and connection limits

- Identify the NAS from the enrolled transport source/private identity and RADIUS secret, not packet-supplied `NAS-IP-Address` alone. Reject unenrolled routers and wrong bindings.
- Link sessions by trusted NAS identity, session ID, persistent service, authorization correlation, and boot/reuse evidence. A username alone is not enough to attribute delayed accounting to a renewed period.
- Preserve existing duplicate handling, monotonic counters, late Stop behavior, and durable-before-ACK semantics. Keep ambiguous/unmatched events in diagnostics instead of guessing a customer.
- Use durable, short-lived admission reservations to prevent two simultaneous logins from passing a one-session check before either Start arrives. Handle repeated authentication packets, expired reservations, missed Starts/Stops, NAS restarts and reconciliation.
- Distinguish confirmed active, stale/unknown, and stopped sessions. An old open row cannot prove a customer is online; a missing Stop must not release a slot blindly while the NAS still has a live session.
- Split usage attribution at entitlement boundaries or reconnect on renewal in v1. Never charge the entire lifetime of a session to whichever period happens to be current when an interim arrives.
- Display session start, last update, IP, CPE MAC, router, upload/download, duration, disconnect reason, and enforcement state. PPPoE normally sees the CPE connection, not every phone/laptop behind its NAT; existing device limits must not be presented as a count of household devices.

## 5. Router onboarding from the dashboard

Add a PPPoE service setup flow to the existing router workflow:

1. Select an existing managed router, or enroll a router with a short-lived, one-use bootstrap token and a generated command. Do not place permanent privileged credentials in URLs.
2. Discover RouterOS version, PPPoE servers, interfaces/VLANs, PPP profiles/pools, RADIUS settings, routing and existing local PPP secrets without exposing secrets. Detect ownership by another billing system.
3. Select an existing PPPoE server first. Creating a server is a separate guided step requiring explicit interface/VLAN, local address, remote pool, and service name; do not guess a production LAN interface or add NAT/firewall rules blindly.
4. Establish a private VPS-to-router path. Select tunnel transport after capability discovery; do not assume older RouterOS supports the same tunnel options as newer devices. RadSec may be qualified where supported; the disconnect/management return path still needs its own protection.
5. Preview narrowly scoped changes, back up affected configuration, apply with operation markers and existing device change protection, then verify. PPP AAA configuration can affect other PPP services, so detect those dependencies first.
6. Check RADIUS reachability, PPP authentication, IP allocation, forwarding/DNS, accounting, disconnect, speed enforcement, and expiry. Mark each stage separately.

Local PPP secrets can take precedence over RADIUS. Detect username collisions and provider fallback paths before enrollment; require a controlled cutover instead of deleting existing accounts or silently leaving an expiry bypass. Keep emergency router-administration access separate from subscriber authentication.

Use per-router secrets and restricted private interfaces/firewall rules. Configure and verify the actual disconnect listener; do not assume every router uses a standard CoA port. No public RADIUS exposure in the default development Compose stack.

## 6. Dashboard design

Keep the current compact customer page, theme tokens, and modal patterns:

- Customers table: service type and concise connection status; existing customer number remains its own column.
- Customer > Access: a persistent PPPoE connection card with username, router/service, package, expiry, last connection and requested/applied state.
- Modals: create PPPoE connection, reveal newly created credentials, reset password, change router/pool/CPE binding, and disconnect. Never add another primary tab bar solely for PPPoE.
- Manage access: reuse controls, speed overrides, schedules, vacation, devices, provisioning and alerts; identify unsupported live operations clearly.
- Packages: service eligibility; Payments: select the connection being funded/renewed where needed. Continue using the product label Payments.
- Access accounts and sessions: service-type filter, PPPoE identifiers, stale/unknown states and useful failure reasons.
- Dashboard: PPPoE paid/complimentary, active/expired/suspended, confirmed online/unknown/offline, expiring soon, failed login summaries, provisioning failures and recent payments. Keep revenue totals free of duplicate or simulated receipts.

Permissions follow existing fleet/site restrictions. Credential reveal/reset and router changes require appropriate write permission and sanitized audit events. No credential delivery by SMS/email in this phase.

## 7. Implementation order and acceptance gates

| Step | Deliverable | Gate |
| --- | --- | --- |
| A — Foundation | Persistent service schema, legacy migration, package eligibility, APIs, credential lifecycle | Existing Hotspot/billing tests pass; renewal preserves login; no credential leakage or cross-customer assignments |
| B — Dashboard | PPPoE create/detail/reset flows with simulated status | Complete staff workflow in light/dark mode and mobile without a router |
| C — RADIUS lab | Allowlisted test NAS, selected auth methods, policy replies, admission reservations | Real RADIUS packets exercise accept/reject, concurrent login, replay and wrong-secret cases; ordinary lab/default production auth remains rejecting |
| D — Accounting | Correlated sessions, usage, stale handling and reconnects | Duplicate/late/reordered packets and NAS restarts cannot duplicate usage, revive stopped sessions or restart purchased time |
| E — Enforcement | Activation handshake, renewal, expiry, disconnect, speed changes, pause and schedule transitions | Simulator/protocol tests cover timeouts, crashes after apply, uncertain responses and stale commands |
| F — Onboarding | Capability discovery, generated setup, preview/recovery, private connectivity | Virtual MikroTik/physical test validates real RouterOS behavior without changing unrelated services |
| G — Pilot | One test router and one test subscriber | Connect, browse, measure speeds, expire while backend is down, renew with same login, suspend, pause/resume and recover after router restart |

Foundation, dashboard, compatible funding and pending router assignments are implemented. The [database-backed authentication lab](pppoe-authentication-lab.md) adds saved-credential PAP/CHAP, policy checks, serialized admission reservations, correlated accounting and separately confirmed shadow activation. It does not complete the production accounting, enforcement or onboarding gates: NAS restarts, physical disconnect, real readiness evidence and recovery still need qualification. Production authentication remains rejecting.

### Tests available while credentials/hardware are pending

- Isolated FreeRADIUS packet tests, fictional customers and test entitlements.
- Policy and race tests for wrong password, unpaid/expired access, wrong NAS/service, optional CPE binding, duplicate login, concurrent renewal and reset.
- Recovery tests for lost Accept/Start/Stop, delayed accounting, failure before/after apply, bounded provisional access, database outages, stale jobs and schedule changes.
- Migration tests against existing Hotspot/account/session data and restore tests for encrypted credentials plus keys.
- UI previews using fictional data, frontend/backend builds and targeted lint.
- Optional virtual RouterOS lab if a suitable VM/runtime is available; this still does not prove RB951 forwarding or all future models.

Use complimentary test entitlements and simulated receipts, clearly isolated from real revenue. A genuine offline receipt can use the existing manual-payment path. PayHero is tested separately when its credentials arrive; its verified funding result later enters the same entitlement workflow.

### Live release prerequisites

Require a reachable test NAS, a test CPE/client, private VPS connectivity, configuration backup/recovery, tested authentication methods, router-enforced time/speed limits, proven accounting correlation, and the full pilot lifecycle. Do not remove the production reject gate merely because the UI or packet lab passes. Roll out with a feature flag and per-router enrollment; keep a rollback that preserves financial and session history and avoids concurrent control by ISPMan and this system.

## References

- Existing project design: [RADIUS lab](radius-integration.md), [billing domain](billing-domain.md), [customer access](customer-access-v1.md).
- [MikroTik RADIUS reference](https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS): PPP integration, local user precedence, reply attributes, accounting correlation, disconnect and CoA. Relevant attributes are qualified per service/version rather than assuming Hotspot and PPP behave identically.
- [MikroTik PPP AAA](https://help.mikrotik.com/docs/spaces/ROS/pages/132350049/PPP+AAA) and [PPPoE](https://help.mikrotik.com/docs/display/ROS/PPPoE): authentication methods, profile defaults and PPPoE server configuration.
- [FreeRADIUS documentation](https://www.freeradius.org/documentation/): use documentation matching the pinned FreeRADIUS 3.2 lab release; do not mix in unqualified 4.x configuration.

Documentation checked through Context7 and official sources on 2026-10-16. MikroTik's legacy help site points to its newer manual site; the newer site returned HTTP 403 during this review. Recheck the target RouterOS release documentation when implementing and qualifying router configuration.
