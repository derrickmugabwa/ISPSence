# Local MikroTik Manager baseline

## Packages module

Open `https://localhost:8443/billing/packages` or choose **Billing → Packages**. Fleet administrators can create/edit offers and enable/disable them; fleet viewers/operators can read them. Site-scoped accounts cannot access this deployment-wide catalog.

Packages persist in the additive `billing_packages` PostgreSQL table. The form shows KES, Mbps and decimal GB; storage uses integer KES minor units, bits per second and bytes. An empty data cap means unlimited. Calendar months remain a distinct duration unit. Updates include a version check to reject concurrent overwrites. No router commands, charges or subscriptions are created by saving a package.

Hotspot assignment is deferred until onboarding provides verified service records. Package deletion is intentionally unavailable; disable an offer to retain its history. Future orders must snapshot terms rather than reference editable offer values for fulfillment.

The temporary-fixture API integration check runs inside the existing backend runtime:

```powershell
Get-Content -Raw scripts/check-packages.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

It creates temporary staff/package fixtures and removes them after testing; HTTP audit traces remain. Do not run it against production.

The module passed 23 targeted backend tests, backend/frontend lint, TypeScript/production builds and live database/API checks on 14 October 2026. Automated rendered-browser inspection was unavailable because the browser tool could not initialize its kernel assets; the page still needs a visual check in a signed-in browser.

## Customers and Payments

Fleet administrators can open **Billing → Customers** (`/billing/customers`) to add/edit subscriber details and open a customer's filtered payment history. Contact numbers are normalized; a contact number is not an authentication credential and is not required to be unique.

**Billing → Payments** (`/billing/payments`) shows reference, customer, payer, frozen package, amount, payment status and access status. Select **New payment** to save an awaiting-payment record. The payer can differ from the customer. No STK request, cash confirmation, provider settlement or router activation is implemented by this action. There is no manual status-changing endpoint in this slice.

Internally `billing_purchases` preserves the package purchase independently of future provider attempts, while the dashboard uses the agreed name **Payments**. Amount and terms come from the server's current enabled package, with a version precondition. Request UUIDs deduplicate repeated submissions; the database prevents editing frozen terms. Changing a package does not change existing payment records. There are no deletion controls for customer/payment history.

`billing_customers` and `billing_purchases` are additive tables. Customers/Payments APIs are fleet-admin only until narrower financial permissions are designed; network viewers/operators and site-scoped admins cannot read these personal/financial records.

Integration check (local environment only; creates and removes temporary fixtures):

```powershell
Get-Content -Raw scripts/check-customers-payments.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

It checks real permissions, normalization, customer edits, concurrent payment deduplication, exact/frozen package terms, distinct payer, stale/disabled offer rejection, immutable purchase fields and history. Audit traces remain after cleanup.

Validation on 14 October 2026: 46 billing backend tests passed, backend/frontend lint and frontend type-check passed, production builds succeeded, live integration checks passed, and HTTPS health/frontend checks passed. Five concurrent identical submissions produced one record; edited/disabled packages did not alter saved purchase terms. Temporary fixtures were removed. Automated rendered-browser inspection remains unavailable as described above.

## Subscriptions and Access accounts

Fleet admins can open **Billing → Subscriptions** (`/billing/subscriptions`) and **Billing → Access accounts** (`/billing/access-accounts`). Preparing a subscription links a payment record to one reserved account identity. Repeated preparation returns the same subscription/account per payment and mode.

Live mode is preparation only: unpaid purchases remain awaiting payment, with no start or expiry timestamp. Even a purchase marked paid cannot be activated through the simulation endpoint. Database constraints prevent live active periods and credential issuance in this implementation. A reserved account identifier is not a usable router login. Router/Hotspot binding is unassigned until onboarding and a verified access adapter are connected.

Simulation mode requires explicit confirmation, is labelled throughout the dashboard, and never changes the payment record's payment/access statuses. Activation atomically records test readiness, effective start/expiry, account state and a transition event in PostgreSQL. Concurrent retries preserve the original timestamps and produce one activation event. Expired tests cannot restart their clock.

The simulation expiry sweep runs at startup and every 15 seconds. It updates due simulation periods/accounts and records an event in one transaction; future simulations and all live records are excluded. These are durable database simulation states, not proof of offline RouterOS enforcement or live network session tracking. Fixed hours/days/weeks use elapsed seconds. Calendar months use the frozen purchase timezone and clamp a missing day to the last day of the target month.

This subscription slice does not implement renewals, device enrollment, credentials, real router provisioning or RADIUS accounting. Test customer session history is implemented below. The reserved username, one-device policy, target fields and immutable access times provide the records those integrations will use later.

Local-only integration check (temporary fixtures cleaned, HTTP audit traces retained):

```powershell
Get-Content -Raw scripts/check-subscriptions.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

Validation: 66 billing backend tests passed; backend/frontend lint and production builds passed. Live API/PostgreSQL checks passed for concurrent preparation and activation, immutable effective timestamps, no payment mutation, blocked live activation/credential issuance, due-only expiry, expired retry safety, calendar-month clamping (including leap year), elapsed-day DST behavior and linked account metadata. Temporary fixtures were removed. HTTPS/API/frontend-asset checks also passed. Rendered UI inspection remains unavailable through the browser automation tool.

## Customer sessions (simulation accounting)

Open **Billing → Customer sessions** at `/billing/sessions`. Fleet administrators can search by customer, payment reference, account, client IP/MAC or test router label; filter active/ended tests; and inspect start, usage-update and stop history. Results use server pagination (50 records), summaries across the matching result set, and 15-second refreshes. Detail history shows the latest 100 events. Download/upload are cumulative bytes from the customer's perspective, displayed in decimal MB/GB. Times are recorded by the server and displayed in the browser's local timezone.

To explore the workflow, create a customer, package and pending payment, prepare a **simulation** subscription, and activate that simulation. Then choose **New test session**, select its account, confirm test mode and start. The default IP/MAC and router label are test values. Use **Usage / stop** to record cumulative traffic or end the test, and **Details** to inspect its history. A subsequent connection creates a separate session. Test fixtures are not seeded automatically into the customer directory.

The new `billing_sessions` and `billing_session_events` tables retain linked customer/account identity, client addresses, test router label, connection timestamps, counters and stop reason. `/api/billing/sessions` lists matching history; `/:id` returns details; `/simulation` starts a test; and `/:id/simulation` records test usage/stops. Writes require explicit confirmation and UUID request keys. Replayed requests retain their original result; different details with the same key conflict. Requests serialize per subscription, one active session is allowed per account, counters cannot decrease, and ended sessions cannot reopen. Live, unactivated and expired subscriptions cannot start test sessions. Client-provided timestamps, source and physical-router IDs are rejected.

Simulation expiry closes active test sessions and records their stop events in the same transaction as subscription expiry. The session end is the subscription expiry boundary, even if the sweep runs later. Recorded counters remain the last supplied totals; no traffic is invented for the interval before expiry. Between sweeps an overdue test can still appear active for up to the 15-second sweep interval, but start/update/stop commands check entitlement expiry immediately and reject it. These records never mark payments paid, issue credentials, send router commands or prove a real customer is online.

Real RADIUS ingestion is not connected. It will require authenticated NAS identity, router/account mapping, durable packet deduplication using NAS and accounting-session identities, handling restarts/out-of-order reports and 64-bit counter rollover, and a policy for stale sessions. This release accepts only simulation sources and deliberately does not expose a router accounting endpoint.

Run isolated API/PostgreSQL integration checks (temporary fixtures removed; HTTP audit traces retained):

```powershell
Get-Content -Raw scripts/check-sessions.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

Validation: 34 session tests and 20 subscription regression tests passed. Session backend/frontend lint, TypeScript checks and both production builds passed. Deployed API/PostgreSQL checks passed for permissions, test consent, live/pending/expired guards, concurrent duplicate starts and updates, one-active-session enforcement, cumulative counters, closed-history protection, reconnects, expiry timestamps/events, pagination and summary totals. Existing subscription integration and HTTPS/frontend health checks passed after deployment. Temporary fixtures were removed. Browser automation remains unavailable, so the rendered page has not received visual inspection.

## Customer profiles, complimentary access and speed overrides

Open **Billing → Customers → View customer** (or select a customer name). `/billing/customers/:id` provides contact details, notes and editing, plus Overview, Access, Payments, Sessions and Changes sections. Payment and session data are filtered by the server for that customer. Sessions retain pagination; speed history shows the latest 50 changes. The profile and controls require a fleet administrator.

**Complimentary access** explicitly authorizes an access period with no payment. Choose an enabled package, enter a reason, select live preparation or simulation, and confirm the grant. Its package supplies a finite duration/data allowance; time remains unstarted until access becomes effective. This creates a separate period without replacing an existing one. Live grants remain pending activation until router integration exists. To test without hardware, choose simulation, confirm test mode, then activate it under Access and start a test session.

`billing_access_grants` is separate from `billing_purchases`: it records the reason, administrator, immutable package snapshot and a constrained zero charge. A subscription has exactly one funding source (purchase or complimentary grant), preserved by database constraints/triggers. No fake paid purchase, successful provider payment, real credentials or router access is produced. Request keys serialize retries; changed details with the same key conflict. Grants appear under Access, not Payments. Access and session list queries support either funding source.

**Speed override** sets desired download and upload rates for all current/future access accounts belonging to that customer. Both rates must be positive, or both null to restore the frozen package speeds for each period. Saving requires a reason and settings version. Concurrent stale changes conflict; exact network retries do not duplicate history. Resetting preserves its audit trail. Package prices, original speeds, duration, data caps, activation/expiry timestamps and payment status remain unchanged.

Settings live in `billing_customer_network` with revisioned history in `billing_customer_network_events`. The profile and access records explicitly show **not applied** for router enforcement: this is a saved desired policy, not proof that an existing device or RADIUS session has changed speed. Router integration must later reconcile the settings version and acknowledge application, including changes to already connected customers.

API: `GET /api/billing/customers/:id` returns profile/settings/history, `PUT /:id/speed-override` saves or resets desired rates, and `POST /:id/complimentary-access` prepares an authorized grant. Subscription/session lists accept a validated `customer_id` filter.

Local API/PostgreSQL check (temporary fixtures removed; HTTP audit traces retained):

```powershell
Get-Content -Raw scripts/check-customer-access.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

Validation: 110 relevant backend tests passed, along with backend/frontend lint, TypeScript checks and both production builds. Deployed profile/API/PostgreSQL checks passed for zero-charge grants, separation from payments, concurrent grant replay, immutable funding, speed precedence/reset, stale-save rejection, audit history, customer isolation, preserved package terms/timestamps and complimentary simulation/session linkage. Existing subscription and session integration checks and HTTPS/frontend health checks also passed. Temporary fixtures were removed. Rendered browser inspection remains unavailable through the local browser automation tool.

## Billing UI aligned with Devices

The billing lists use the Devices page's full-width layout, 28px plain title, inline counts, shared `FilterBar`/`FilterSearch`/`FilterSelect`/`FilterSegment`, `card`, `btn-primary`, `btn-secondary`, `input` and `table-header` styles. Large summary tiles, title icon tiles and accent-topped form cards were removed. Tables use 10px header / 12px row padding, compact monochrome metadata, and the same surface hover color. Customer profile sections, forms and status indicators follow the same compact styling. Financial/provisioning behavior is unchanged.

The in-app browser is now available, but opening the local HTTPS reference was blocked by `ERR_CERT_AUTHORITY_INVALID`. The implementation was compared against `DevicesPage.tsx` and its actual shared components; rendered comparison still needs a browser that trusts the local development certificate.

Create/edit package and customer forms, new payments/subscriptions, test-session start/usage, customer speed overrides and complimentary grants now open in a shared modal. Payment/session details also use dialogs. The customer profile remains a full page. Native `dialog.showModal()` and a React portal keep focus inside the dialog and the background inert; Escape/Close are blocked while a mutation is pending, background clicks do not discard the draft, and focus is restored on close. Form validation, API handlers and request keys remain unchanged. Cancel precedes the primary action, matching Devices dialogs.

## Local stack commands

The application lives directly in the `isp-billing` project root: `backend/`, `frontend/`, `nginx/` and `docker-compose.yml`. It started from pinned upstream commit `1d8f405ccb28db5e90a10d4c440fba916b84257e`. The local Compose project name remains `isp-billing-dev`, and generated credentials remain in `.local/manager.env`. Treat that environment file as a secret; do not commit or share it.

Run commands from this project folder with Docker Desktop's Linux engine running.

```powershell
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml config --quiet
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml up --build -d --wait --wait-timeout 240
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml ps
```

Open https://localhost:8443. The upstream stack generates a self-signed certificate locally. Initial credentials are `admin` / `admin`; the application requires a password change before normal use.

HTTP redirects from http://localhost:8080 to HTTPS. Web and NetFlow ports are bound to loopback. No VPS deployment or real router configuration is performed by starting this stack.

Stop without deleting data:

```powershell
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml stop
```

PostgreSQL, Redis, InfluxDB, backups, certificates and generated application keys use project-scoped Docker volumes. Preserve the environment file and application-key volume when backing up. Do not use `down --volumes` for routine shutdown.

The source Dockerfiles provide their own Node runtime; the host Node installation is not used to compile the containers. Starting the stack does not by itself establish that the upstream test suites pass.

Run the local smoke checks after startup:

```powershell
node scripts/check-local-baseline.mjs
```

These check HTTPS health, the compiled frontend asset, authentication enforcement, and (on a fresh database) default-admin login, mandatory password change and logout revocation. Tokens are never printed. The script accepts the self-signed certificate only for its fixed loopback target.

## Windows checkout line endings

This machine initially checked out `nginx/entrypoint.sh` with CRLF line endings. The Linux container could not execute it and restarted with `exec /entrypoint.sh: no such file or directory`. The working copy was normalized to LF; Git reports no source-content diff. Preserve LF for shell scripts after future checkouts. If this issue recurs, normalize the entrypoint before rebuilding nginx:

```powershell
$entryPath = Join-Path (Get-Location) 'nginx\entrypoint.sh'
$entryText = [System.IO.File]::ReadAllText($entryPath)
[System.IO.File]::WriteAllText($entryPath, $entryText.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml up --build -d --wait nginx
```


## Private RADIUS accounting lab

The optional FreeRADIUS overlay, packet checks, and remaining router integration work are documented in [design/radius-integration.md](design/radius-integration.md). Billing > RADIUS diagnostics shows labelled loopback test records separately from customer sessions. This lab has no public ports and cannot authenticate live customers.
