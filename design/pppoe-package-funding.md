# PPPoE package funding and prepared renewals

Implemented 2026-10-16. Router binding, RADIUS authentication and live activation remain disabled.

## Staff workflows

- Packages: choose Hotspot, PPPoE, or Both on create/edit; the catalog shows a Service column. Existing packages default to Hotspot. Omitted eligibility on older update requests preserves the saved value; supplied values are validated and canonicalized.
- Payments and dashboard offline payments: select a customer, then Hotspot access or one of that customer's PPPoE connections. Only enabled compatible packages appear. Changing the customer/connection clears the package selection. Backend validation repeats all ownership, mode, version and compatibility checks.
- Payment details: record money already received using the existing receipt form, or use the existing PayHero collection flow. Recording a purchase alone does not record payment or prepare a funded PPPoE period. A confirmed receipt prepares access without starting paid time.
- Customer > Complimentary access: select the connection and a compatible package. PPPoE preparation is live-mode only; it does not create a payment and still cannot grant actual router access.
- Customer > Access: PPPoE rows show prepared-period counts and a payment/renewal link. The payment form retains the selected connection when opened from this link. Access periods and billing reports show the persistent username rather than the internal period-account identifier.
- Captive portal editor, draft validation, publication, public catalog and public checkout exclude PPPoE-only packages. Already-published catalogs also stop displaying a package if its eligibility subsequently changes to PPPoE only. Purchased terms remain unchanged.

## Durable contracts

`service_id` is an optional UUID in payment and complimentary-grant requests. Omission selects Hotspot; supplying it selects a live prepared PPPoE service owned by that customer. The source record stores an immutable foreign key and the package snapshot freezes `service_type` plus the selected service ID. Replaying an idempotency key with another connection is a conflict.

Database guards reject incompatible new funding, mismatched customer/service references, and later reassignment. Existing purchase/grant snapshots are not rewritten. A later price, eligibility or package-status edit does not invalidate already-purchased terms when payment is verified.

On verified payment or an authorized complimentary grant, `billing_service_periods` links the new live subscription to its persistent service. It validates customer, mode and funding source, and retains immutable history. Multiple prepared periods receive a durable ordering sequence. These are pending periods, not concurrently activated entitlements or a claim that a live renewal scheduler is operating. Only a future tested provisioning adapter may make a period effective. Existing renewal controls also reject predecessor/successor pairs for different connections.

Credentials belong to the service and do not change during purchase, grant, payment verification or renewal. Original activation/expiry timestamps remain untouched. No paid time is consumed by these preparation workflows.

Per-period `billing_access_accounts` rows remain internal compatibility records for existing joins/APIs. Their generated identifiers are not new PPPoE logins and receive no credential. PPPoE UI/reporting resolves the actual username from the persistent service. Repeat migration excludes these technical rows from legacy Hotspot adoption.

## Verification

- Backend/frontend production builds, targeted lint, and 212 related route/domain tests passed. Existing portal-editor lint warnings remain unchanged.
- `check-pppoe-foundation.cjs` plus `check-pppoe-funding.cjs` verify real SQL/HTTP behavior inside a disposable schema: eligibility, direct-request rejection, owner/mode checks, frozen funding identity, receipt/grant idempotency, prepared-period ordering, stable credentials, dashboard username, unchanged purchased terms, portal exclusion and repeat migration.
- The HTTP harness uses a fictional administrator inside its container only. It never contacts PayHero, creates a real payment, or modifies a router.
- Browser verification used actual components with fictional data: package creation/service column, compatible payment options, received-payment completion, PPPoE complimentary selection and simulation restriction, renewal connection context, light/dark mode and a 390px viewport.
- A local database backup is retained under ignored `.local/backups/` before deployment.
