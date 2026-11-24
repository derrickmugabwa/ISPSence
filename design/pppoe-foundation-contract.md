# PPPoE foundation contract

Current implementation: persistent draft services, encrypted credential creation/reset, customer dashboard controls, and additive legacy mapping. The full sequence is in [the implementation plan](pppoe-implementation-plan.md).

## Identity and migration

- A service belongs to one customer, has a permanent UUID and normalized unique username, and is separate from purchased periods. New PPPoE usernames use lowercase ASCII letters, digits, dots, underscores and hyphens (3–64 characters); realms are deferred. Generated names use `ppp_` plus random entropy. Customer numbers remain independent.
- `billing_service_periods` is the future service-to-entitlement boundary. One subscription can belong to only one service. Database validation requires matching customer and live/simulation mode, and preserves the assignment on update. PPPoE assignments now permit prepared live periods backed by matching immutable funding; see [package funding](pppoe-package-funding.md). Effective live activation remains blocked.
- Existing access accounts are mapped one-to-one into `legacy` Hotspot services, using the original access-account UUID in the new table. This deliberately does not infer that multiple old logins represent one persistent service. Original accounts, subscriptions, sessions, IDs, receipts and effective timestamps remain unchanged.
- Backfill is transactional, serialized with a transaction advisory lock, and repeatable. Legacy accounts created by existing application paths after migration are adopted on the next migration run; this is not a replacement for those paths yet. The next slice must make all new account creation service-aware before using this layer for live policy/reporting.
- Packages gain a canonical `service_types` array, defaulting existing and new packages to `['hotspot']`. Allowed values are `['hotspot']`, `['pppoe']`, and `['hotspot','pppoe']`. The package editor and funding/portal eligibility checks now support these values together.
- No legacy live-activation or credential constraints are weakened. Services remain drafts with optional saved credentials, prepared entitlement assignments and pending router bindings. Production RADIUS authentication remains disabled. The separate [database authentication lab](pppoe-authentication-lab.md) exercises fictional enrollments and shadow periods only. No customer or trial service is created in production as part of migration tests.

## API

Fleet administrator only; both responses use `Cache-Control: no-store`.

`GET /api/billing/customer-services?customer_id=123` returns that customer's service summaries. Customer selection is required. A nonexistent customer has an empty list.

`POST /api/billing/customer-services` prepares a live PPPoE draft:

```json
{
  "customer_id": 123,
  "label": "Home connection",
  "username": "home-123",
  "reason": "New home service",
  "request_key": "34d46d47-0f12-42a5-a68a-7c288190933b"
}
```

Omit `username` to generate one. All other fields are required. Reject unknown fields, including passwords, mode, router, active state and credential-issued flags. Response is `{service, replayed}` with 201 for creation and 200 for an identical replay. The same request key with changed normalized input returns 409; usernames are unique across services. Creation takes the customer lock before writing the service and sanitized management event in one transaction. Concurrent identical creates for the same customer return one identity and one event. A reused key across customers is a conflict, not permission to disclose another customer's service.

Summary fields: `id`, `customer_id`, `service_type`, `mode`, `username`, `label`, `state`, `version`, `created_at`, `credential_revision`, `credentials_updated_at`, `prepared_periods`. No encrypted material or internal request payload is returned. Unknown routes do not reset credentials or provision equipment.

## Contracts required before live access

- RADIUS authentication: qualify PAP and CHAP against the saved method-compatible encrypted password. MS-CHAPv2 requires separate qualification. No MS-CHAPv1 default. Credential storage alone does not implement or enable any RADIUS authentication method.
- Activation: draft -> configured -> bounded authorization reservation -> confirmed NAS readiness -> effective period. Access-Accept alone is not activation. Proven never-enabled attempts may be rescheduled; uncertain attempts reconcile evidence and cannot receive fresh paid time.
- Renewal: new period, same service/login, preserved original/effective timestamps. One current entitlement; queued successor preserved until effective transition. No database/router atomicity assumption.
- Compatibility: record discovered RouterOS version, PPP service/profile/pool, authentication methods, accounting correlation, rate-limit direction, session timeout/deadline behavior, private transport and disconnect listener. Support follows tested capabilities, not a router-model allowlist.

Prepared financial assignment is implemented; RADIUS acceptance, live enforcement, and onboarding remain subsequent work. Customer > Access now exposes the PPPoE connections card and its add/password modals.

## Verification completed — 2026-10-16

- Backend production build and targeted lint passed; 121 tests passed across customer services, packages, subscriptions, customer access and RADIUS accounting.
- `scripts/check-pppoe-foundation.cjs` passed against a disposable PostgreSQL schema: paid/complimentary and live/simulation legacy mapping, preservation of historical sessions and effective timestamps, repeated migration, concurrent idempotent creation, ownership checks, disabled live gates, and full rollback/retry after a case-insensitive username collision.
- Local database backup saved under ignored `.local/backups/` before deployment. Backend deployed healthy; HTTPS health returned 200, unauthenticated service API returned 401, and the private authorization endpoint continued to reject with 403.
- All existing local access accounts were mapped. Integration fixtures were removed with their disposable schema; no real PPPoE draft, credential or payment was created by verification.


## Credential workflow — 2026-10-16

`POST /api/billing/customer-services/:id/credentials` is fleet-admin only, for live-mode draft PPPoE services. Body: `{version, reason, request_key}`. It generates a random 24-character password server-side; client-supplied passwords and unsupported fields are rejected. Existing Hotspot account credential gates remain intact.

The transaction locks customer first, then service. It replaces only the encrypted current credential, increments its revision and the service version, records the sanitized request identity and a management event, and commits before responding. The service username and all paid-time records are unchanged. Version checks reject concurrent distinct resets against stale data. Identical retries return `{service, password: null, replayed: true}` without rotating again or exposing old/new password material. A request key cannot be reused for another service or changed input.

The original successful response alone contains the new password. All route responses, including refusals, use `Cache-Control: no-store`. No endpoint reads an existing password. If the response is lost or the modal is closed before copying, refresh the connection and request a new reset. This is intentionally a new operation and produces a new password; retrying the old request cannot recover its one-time value.

AES-256-GCM uses the manager's existing persistent encryption keys outside the database. The credential column participates in key status/rotation; its sweep compares the old ciphertext before updating so a concurrent password reset is never overwritten. Database and key backups must be restored together. Plaintext passwords never enter service summaries, request records or management events.

The dashboard retains the one-time value only in the mounted modal's React state, clears it on close/unmount or after five minutes, and masks it initially. It is not returned as mutation cache data or saved to browser storage. Password requests have no automatic retry/offline queue. Copy is an explicit staff action. Prepared credentials do not bind a router or enable access; the card reports setup pending and router not assigned.

Verification: backend/frontend production builds and targeted lint passed. All 86 targeted tests passed (credentials/roles, key rotation, subscriptions and customer access). The disposable PostgreSQL check passed concurrent issuance/replay, encrypted round-trip, reset revision/username stability, stale/conflicting reset rejection, redacted summaries/audit/request data, legacy gates and migration preservation. Fictional-data browser checks covered add connection, password generation, reveal cleanup, reset confirmation, light/dark mode and a 390px viewport without document overflow.
