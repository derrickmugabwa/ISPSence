# MikroTik Manager foundation gap analysis

Reviewed: 14 October 2026 (Africa/Nairobi).

## Decision

**Conditional go for a laboratory prototype; production approval remains pending.** Reuse MikroTik Manager for device inventory, router transport, staff administration, monitoring, and the administration UI. Build billing as separate modules in the same deployment. The source contains useful Hotspot primitives, but it is not an existing ISP billing platform.

Phase 0 is not complete. Router enforcement, the current ISPMan integration, PayHero verification, operational recovery, and architecture acceptance still need evidence. No billing modules or upstream source files were changed during this review.

## Source and scope

- Repository: https://github.com/2GT-Media-Group-LLC/mikrotik-manager
- Inspected commit: `1d8f405ccb28db5e90a10d4c440fba916b84257e`.
- Package manifests: `0.54.0-beta`; commit subject: `0.54.0: FastTrack warning on queues, read-only switch-chip VLANs`.
- Original review checkout was `upstream-review/`; application source and Git metadata now live directly in the `isp-billing/` project root. This remains a shallow clone, not a GitHub fork, and `origin` still points to the original repository. Local ignore rules and setup documentation have been added.
- Method: static inspection of routes, router methods, schema, middleware, manifests, deployment files, and related services. Repository searches found no application billing tables or PayHero/M-Pesa integration.
- Not performed: dependency installation, build/test execution, dependency vulnerability audit, application launch, router commands, payment requests, or live network testing. Existing tests are evidence of test infrastructure, not proof they pass here.

## Verified architecture

| Area | Source evidence | Implication |
| --- | --- | --- |
| Backend | `backend/package.json`, `backend/src/index.ts`: TypeScript, Express, Socket.IO | Add billing services and routes without replacing the backend. |
| Frontend | `frontend/package.json`: React, Vite, React Query, Tailwind, Zustand | Reuse admin layout and established UI patterns; create a customer portal. |
| Persistence | `backend/src/config/database.ts`, `backend/src/db/migrate.ts`: PostgreSQL, direct SQL, transaction helper | Use additive billing migrations and proper transactional outbox records. |
| Background work | `backend/src/services/PollerService.ts`: BullMQ workers and Redis | Reuse queue infrastructure, with dedicated billing queues and recovery policies. Do not treat disposable monitoring jobs as financial work. |
| Metrics | Compose and poller: InfluxDB | Reuse for network monitoring; keep financial and entitlement truth in PostgreSQL. |
| Deployment | `docker-compose.yml`: nginx, backend, PostgreSQL, Redis, InfluxDB and persistent volumes | Existing deployment foundation; database/secret restore and billing worker recovery still need rehearsal. |
| License | `LICENSE`: GNU Affero General Public License version 3 text | Record the license as verified. Commercial-license availability and the intended distribution model remain unverified; this is not a legal clearance. |

## Reuse versus build

| Requirement | Existing implementation | Required work |
| --- | --- | --- |
| Multiple routers | `devices` records, connection services, site organization | Bind each billing entitlement to a device and one Hotspot service. |
| Router credentials | Encrypted device fields and AES-256-GCM helpers in `utils/crypto.ts` | Apply secret controls to provider credentials and rehearse encryption-key recovery. |
| Hotspot administration | `routes/guestWifi.ts`; `DeviceCollector` Hotspot methods | Reuse transport/read/write primitives behind a billing access adapter. |
| Profiles and speed | Hotspot profile creation; setup writes `rate-limit` and `shared-users` | Add package-to-profile synchronization, updates, immutable terms, and enforcement tests. |
| Vouchers | Random code generation, router-user creation and printable sheet | Build persistent issuance/redemption/revocation records, hashed secrets, atomic redemption and billing audit. |
| Walled garden | List/add/delete hostname entries | Validate actual unauthenticated DNS/HTTPS/portal flow and restrict publicly reachable routes. |
| Active sessions | List and disconnect Hotspot sessions | Add entitlement-aware expiry, renewal checks, device replacement and reconciliation. |
| Staff access | JWT sessions, admin/operator/viewer roles, TOTP/OIDC support | Add explicit financial permissions. A cashier must not inherit unrestricted network operator powers. |
| Audit | HTTP write audit middleware and `audit_log` | Add durable business events for callbacks, worker outcomes, refunds, cash, and entitlement changes. |
| Subscriber identity | Network `clients` and application `users` exist | Create subscriber/customer identity separately. A network-observed client is not a billing customer; staff users are not subscribers. |
| Packages/orders/payments | No billing implementation found in source searches | Build frozen purchase terms, attempts, provider interface, verification, matching, exceptions and reconciliation. |
| Subscriptions/access periods | No billing implementation found | Build effective/proposed timestamps, purchased periods, capped allowances, renewal transitions and state history. |
| Customer checkout/login | Guest Wi-Fi page is authenticated administration; router setup creates a Hotspot | Build a public purchase portal and secure customer login/recovery. Existing router setup does not implement payment checkout. |
| Revenue reports/manual payments | Network reports and administration exist | Build billing reports, audited manual grants, payment corrections and export controls. |
| RADIUS | `services/userManager.ts` reads RouterOS User Manager and can remove stale session records | Useful visibility, not a complete billing-driven RADIUS authorization/accounting backend. Decide the access architecture from ISPMan topology and router tests. |

## Important gaps in existing Hotspot behavior

1. **Uptime limits are not evidence of calendar expiry.** The voucher route converts hours into `limit-uptime`; it does not implement the plan's absolute activation-to-expiry contract. Prove expiry and reconnect rejection while the application is offline and after router restart. No production recommendation for local users versus RADIUS is justified yet.
2. **Read failures can look like empty state.** Several `DeviceCollector` Hotspot list methods catch errors and return empty arrays. Billing reconciliation must distinguish an empty router configuration from an unreadable router. Otherwise a failed read could trigger duplicate creation or a false recovery conclusion. Add strict methods or error-aware results without disrupting existing monitoring behavior.
3. **Existing device locking is insufficient for billing consistency.** `changeGuard/deviceLock.ts` permits writes when Redis cannot be checked. Add durable subscription serialization and safe handling of lock loss, and coordinate worker writes with existing guarded router changes. A network rollback can restore older account state; reconciliation must detect it.
4. **Current vouchers are reusable router login identities, not single-use redemption secrets.** The route sets the code as the router username, and the printable UI instructs the customer to leave the password blank. Codes remain observable through router user listing. Do not reuse this identity model for the plan's hashed, single-use voucher requirement. Redeem a billing secret into a separate access identity.
5. **Current voucher creation does not set a Hotspot server binding.** The route creates user parameters with name/comment, optional profile and limits. The billing adapter must explicitly enforce the purchased router/Hotspot binding and test isolation between services.
6. **Customer access and router control need separate exposure rules.** Guest Wi-Fi routes require staff authentication. Add narrow public checkout/status endpoints and authenticated provider callbacks, with no public access to arbitrary device IDs or router commands. Adapt callback parsing to the provider's verified authenticity mechanism before generic JSON parsing if required.
7. **HTTP audit alone is not a financial journal.** Middleware writes audit rows after response completion. Transactional business events must survive process crashes and include background processing, with actor, reason, original transaction and resulting entitlement.
8. **Secure transport needs an explicit deployment policy.** `apiConnect.ts` starts SSL and plaintext connection attempts in parallel when selecting a port. Choosing SSL does not establish that no plaintext login attempt occurred. Require explicit secure transport or an approved private tunnel and test behavior; preserve existing identity checks.

## Proposed implementation boundaries after Phase 0

- Add `backend/src/modules/billing/` for package, order, payment, subscription, voucher and financial reporting logic; keep provider integration behind an interface.
- Add dedicated billing migrations, a PostgreSQL outbox, operation records and billing queues. Use the existing transaction helper correctly: related transactional queries must use its supplied client.
- Add a Hotspot access adapter around strict router operations, effective timestamp evidence, idempotent account markers, desired state and actual-state reconciliation.
- Extend `DeviceCollector` only where necessary for strict reads and missing user/profile update/disable operations. Keep network setup, discovery and monitoring changes minimal.
- Add billing administration pages to the existing UI. Create the public customer portal with independent customer authorization and minimal API exposure.
- Register new routes/workers in `backend/src/index.ts`, extend permissions and audit events, and add deployment/restore documentation for billing state.
- Keep existing `devices`, settings, staff and monitoring records. Add customers, packages, orders, payment attempts/transactions, subscriptions/access periods, access identities, voucher records, provisioning operations, outbox and business events through a detailed schema design. Do not repurpose network `clients` as subscribers.

These paths are proposals, not implemented modules. A small ISP does not need a separate microservice deployment to establish these boundaries.

## Remaining Phase 0 evidence

| Item | Status | Next evidence |
| --- | --- | --- |
| Exact upstream/revision/license | Verified by source inspection | Preserve this revision; do not follow moving `main` implicitly. |
| Architecture and reuse map | Preliminary complete | Confirm build/runtime and dependency health in an isolated environment. |
| Current ISPMan topology | Unknown | Router model, RouterOS version, local Hotspot versus RADIUS/User Manager configuration, current ownership and active-user behavior. |
| PayHero verification | Not investigated in this source review | Official initiation/status/callback documentation, merchant setup, reference matching, authenticity, fees, settlement and reversal behavior. |
| Captive portal purchase flow | Not tested | Unauthenticated test client on an isolated Hotspot, correct DNS/TLS and restricted walled garden. |
| Local enforcement and outage recovery | Not established | Demonstrate absolute expiry, reconnect rejection, caps, device limits, router restart and application outage. |
| Billing activation protocol | Design pending | Demonstrate crash recovery without charging for pre-readiness delay or resetting an effective period. |
| Cross-router roaming | V1 excluded by plan | Confirm this matches actual operational needs. |
| Production go/no-go | Pending | Resolve the above and record architecture acceptance before modifying upstream. |

## Immediate next step

Document the current router/ISPMan topology: router model, RouterOS version, Hotspot service/interface, authentication mode, package behavior and availability of an isolated test router or Hotspot. Do not change live configuration or run the guest-network setup wizard against existing subscribers during discovery. Request only sanitized configuration evidence; passwords, private keys, tokens and subscriber personal information are unnecessary for the initial topology assessment.

## Local baseline follow-up

The owner has authorized local startup while hardware is unavailable. The target deployment is a VPS; compatibility must span MikroTik models rather than be limited to the owner's RB951. ISPMan using RADIUS remains an unverified report.

On 14 October 2026, the pinned source built successfully in Docker and the local stack started with PostgreSQL, Redis, InfluxDB and backend health checks passing, and nginx serving HTTPS on loopback port 8443. A Windows CRLF checkout of the nginx entrypoint initially prevented startup; normalizing it to the repository's LF content and rebuilding resolved the issue without a tracked source-content change.

`node scripts/check-local-baseline.mjs` passed API health, compiled frontend/asset serving, unauthenticated API rejection, database-backed default-admin login, mandatory password-change restrictions and logout/session revocation. No router or payment operations were issued. This establishes local build and basic authentication readiness; it does not establish upstream unit-test results, rendered dashboard correctness, provider integration or network enforcement. See `local-development.md` for repeatable commands.

## Primary source links

- [Pinned source tree](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/tree/1d8f405ccb28db5e90a10d4c440fba916b84257e)
- [Hotspot routes and vouchers](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/1d8f405ccb28db5e90a10d4c440fba916b84257e/backend/src/routes/guestWifi.ts)
- [Router adapter methods](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/1d8f405ccb28db5e90a10d4c440fba916b84257e/backend/src/services/mikrotik/DeviceCollector.ts)
- [Schema](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/1d8f405ccb28db5e90a10d4c440fba916b84257e/backend/src/db/migrate.ts)
- [Deployment](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/1d8f405ccb28db5e90a10d4c440fba916b84257e/docker-compose.yml)
- [License text](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/1d8f405ccb28db5e90a10d4c440fba916b84257e/LICENSE)
