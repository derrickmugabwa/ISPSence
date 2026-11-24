# Database-backed PPPoE authentication lab

Date: 2026-10-17. This is an isolated qualification stage. It does not enable production authentication or live subscription activation.

## Isolation

`PppoeLab` is not imported by the application index, production routes, or migration runner. Its factory requires a randomly named `pppoe_auth_lab_<32 hex digits>` schema. Every transaction verifies both `current_schema()` and the entire explicit search path. `public` and mixed paths are rejected before installing or using lab tables.

The driver builds the real billing schema in that disposable namespace and uses the existing service, credential, complimentary-grant, router-assignment and manual-receipt functions. Passwords use the existing AES-GCM credential storage and random disposable encryption keys. Purchases and receipts are fictional, isolated from public billing records and revenue.

`pppoe_lab_enrollments` explicitly enrolls the fictional NAS against a saved pending binding. It is not a production enrollment API. `pppoe_lab_admissions`, `pppoe_lab_periods` and `pppoe_lab_packets` store reservations, shadow effective periods and correlated packet receipts. No production activation check is removed. The original billing subscriptions stay pending with null activation and expiry dates throughout these tests.

The optional protocol harness binds HTTP only on `127.0.0.1:3009`. A separate FreeRADIUS container shares that test container's network namespace, listens only on loopback, and publishes no ports. A RAM-backed volume holds random protocol secrets and fictional client passwords with restricted ownership/modes. It contains no real subscriber credentials. The authenticated HTTP bridge never returns password material to FreeRADIUS. Typed replies disable xlat expansion and JSON value reinterpretation.

## Authentication and admission

PAP verifies the submitted password against the decrypted saved secret using constant-time digest comparison. CHAP verifies the identifier, MD5 response and either the explicit challenge or Access-Request authenticator. MD5 is used only for the CHAP wire protocol, never as credential storage. MS-CHAP is unsupported and rejected.

The pinned FreeRADIUS 3.2 REST authenticate method requires `User-Password`, so both proofs are checked through REST authorize. Only a successful backend result containing Class, pool, rate and a bounded timeout selects the dedicated verified authentication branch. Errors and incomplete replies reject. Typed CHAP octets are decoded as byte characters, matching the pinned REST encoder; they are never logged.

FreeRADIUS derives transport identity and request authenticator from its own UDP socket/packet, overwriting temporary bridge attributes. The known RADIUS client requires Message-Authenticator. Backend admission also requires matching enrolled source/NAS, the saved server name, current binding revision, optional CPE MAC, PPP framing and service type.

Admission checks the saved customer controls, registered/disabled device rules, schedule, frozen package eligibility/duration, a paid purchase with its matching receipt or complimentary grant, revocation/frozen vacation state, data already recorded against the period, and customer speed override. Later package edits do not rewrite purchased terms.

Lock order is customer, service, subscription, admission. A durable request key comes from trusted source/NAS plus the actual RADIUS request authenticator. Replayed packets revalidate credentials and policy, return the same Class, and reduce the timeout rather than extending the original admission window. No raw password, challenge/response, or full authentication packet is stored in admission history.

Reserved and confirmed sessions count toward the customer's lab PPPoE connection limit across their connections. An initial period admits one first-session transition at a time until readiness is resolved. Open sessions remain capacity-consuming when Stop is missing. Lab PPPoE capacity is not yet unified with production Hotspot sessions.

Replies allowlist PPP framing, profile/group, pool, customer upload/download in `Mikrotik-Rate-Limit`, a correlation Class and bounded session/interim intervals. Sessions are provisionally limited to thirty seconds, reduced near expiry or a schedule boundary, with a five-second authorization-to-start allowance. These are fixture assumptions; actual RouterOS timing and deadline behavior require qualification.

## Accounting and effective time

Class ties a session to a specific service, funding period and admission. Accounting also verifies source, NAS, username, CPE MAC and session ID. Unknown or mismatched correlations fail rather than guessing a customer. Gigawords preserve exact counters; NAS input is customer upload. Duplicate packets are acknowledged only after a durable transaction. Counters increase monotonically, and late packets cannot revive a stopped session or move its usage to a renewed period.

Start records signed event-time evidence, client IP and session identity. The lab models a maximum two-second NAS clock difference and rejects absent/out-of-window first-Start evidence. Delayed Start delivery retains the earlier timestamp. This is not a claim that every router's clock satisfies that bound.

Start alone does not activate a period. A separate test-driver readiness proof identifies the same session and binding and explicitly states when client access became usable. `confirmReady` rejects future, stale-version or out-of-session proofs, then records effective activation, expiry and confirmation time in the lab period. If forwarding was delayed after Start, paid time begins at the separately proved usability time. If access was already usable and evidence arrived late, the earlier verified usability time is retained. Retries and reconnects preserve those confirmed timestamps.

Fixed durations and timezone-aware calendar-month clamping reuse the existing billing-time calculation. A queued period is selected after its predecessor expires; existing session capacity requires Stop/reconnect before the next period can admit. Both periods and their histories remain preserved.

A reservation expiring without Start is an uncertain outcome, not proof of failure. It blocks a new full-duration admission. Only explicit lab NAS evidence that access was never enabled, after the provisional safety lease, permits `confirmNeverEnabled` and rescheduling. A stopped session with unconfirmed readiness also cannot silently obtain another fresh period. Existing active time continues while admission is suspended; live pause/disconnect transitions remain a later enforcement gate.

The [provisioning and recovery workflow](pppoe-provisioning-recovery.md) adds durable operations around that confirmation boundary. Operations own readiness/absence resolution once queued; workers claim leases, reconcile uncertain outcomes, and commit effective time with operation confirmation. The standalone helpers remain only for admissions with no operation.

## Test entry points

From the project root, run `./scripts/run-pppoe-auth-lab.ps1`. It builds the backend and separate protocol image, runs database and real UDP packet checks, verifies results, then removes its test containers and RAM volume. `-SkipBuild` reuses previously built images only; rebuild after source changes. It requires the existing development database and `.local/manager.env`.

- `backend/src/routes/__tests__/pppoeLab.test.ts`: PAP/CHAP validation, malformed credentials and production-schema refusal.
- `scripts/check-pppoe-auth.cjs`: real PostgreSQL schema/functions, funding, concurrent admission/replay, customer controls, accounting, readiness, uncertain outcomes, reset, renewals and calendar tests. It drops its schema in `finally`.
- `scripts/check-pppoe-provisioning.cjs`: durable worker, fencing, retries, reconciliation, policy revalidation and confirmation rollback checks, invoked by the same disposable driver.
- `radius/Dockerfile.pppoe-db-test`: separate pinned FreeRADIUS 3.2 fixture with `pppoe-db-test`, `billing-db-rest` and `check-pppoe-db.sh`.
- `scripts/finish-pppoe-auth.cjs`: asks the private harness to verify packet results and independently confirm mocked readiness before cleanup.

Run the database driver with the development database network and environment file, mounting the driver and provisioning helper into the backend check image. Adding `--serve` runs the HTTP harness after database assertions, writes `/lab/fixture.env` once ready, and has a five-minute timeout. Mount `finish-pppoe-auth.cjs` too. The protocol container must use `--network container:<driver-container>`, the same `/lab` volume read-only, no published ports, all capabilities dropped, and writable temporary/log/run directories only. The fixture volume uses tmpfs with uid 100, gid 101, mode 0770. Stop/remove only the named test containers and remove that disposable volume afterward; preserve the existing accounting lab.

## Remaining production gates

Validation on 2026-10-17: backend build and targeted lint passed; 324 tests across 13 billing/PPPoE/RADIUS suites passed. The disposable PostgreSQL driver and pinned FreeRADIUS UDP fixture passed paid/complimentary PAP and CHAP, explicit/fallback challenges, wrong credentials/shared secret, unpaid/expired/suspended access, binding mismatches, correlated accounting and independent mocked readiness. These results validate the lab protocol and policy, not RouterOS forwarding.

This stage does not implement production NAS enrollment, router configuration, Internet reachability probes, live subscription mutation, dashboard online state, physical disconnect/CoA, NAS boot identity/session-ID reuse, unmatched-packet diagnostics, production Hotspot/PPPoE shared capacity, byte-quota enforcement on the NAS, or outage-safe live pause/resume. Unknown/reused session identities fail closed in the lab.

The shadow clock demonstrates the transaction and timing rules; it is not paid activation in the real app. Wiring this into production requires a reviewed migration, durable operation fencing and recovery, trusted per-router private transport, measured timing bounds, real readiness/absence probes and the physical-router lifecycle tests. The production `/internal/radius/authorize` endpoint must continue returning 403 until those gates pass.

References: [FreeRADIUS 3.2.10 REST configuration and JSON/reply rules](https://github.com/FreeRADIUS/freeradius-server/blob/release_3_2_10/raddb/mods-available/rest), [MikroTik RADIUS](https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS), [implementation plan](pppoe-implementation-plan.md).
