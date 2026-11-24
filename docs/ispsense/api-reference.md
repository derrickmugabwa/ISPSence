## Authentication and permissions

Application APIs live under `/api`. Use the existing authenticated session and backend permission checks. Customer/financial settings and accounting enrollment require fleet administrator privileges; site-scoped access is not equivalent to fleet administration.

This is a reference to the implemented route families, not a public unauthenticated API. Configuration and secret-bearing workflows require appropriate server authorization.

## Billing route families

- `/api/billing/packages`: offers and supported service types.
- `/api/billing/customers`: customer directory and profile records.
- `/api/billing/payments`: saved payment/purchase workflows.
- `/api/billing/subscriptions`: prepared and historical periods.
- `/api/billing/customer-services`: persistent customer service identities.
- `/api/billing/sessions`: paginated shared history; `/:id` returns event detail.

Mutation contracts vary by route. Use each route's validated input, current version, request key, and audit reason where required. Never construct a request by copying a read response containing server-owned fields.

## Accounting source administration

`GET /api/billing/radius/pipeline` returns backlog, worker health, source enrollment, provisioning totals, and observed-session counts.

`POST /api/billing/radius/sources` accepts `device_id`, `source_ip`, `nas_identifier`, `interim_seconds` (30–3600), and `reason`. A new source is disabled.

`PUT /api/billing/radius/sources/:id/status` accepts `enabled`, the current `version`, and `reason`. Source changes are audited and concurrent stale edits are rejected.

## Internal bridge

`POST /internal/radius/observations` accepts parsed accounting only through the authenticated internal bridge and enabled source checks. Public nginx blocks `/internal/`. The bridge must derive socket source identity from trusted RADIUS delivery.

`POST /internal/radius/authorize` remains blocked. Do not expose internal routes to make production login work.

## Architecture

PostgreSQL retains requested policies, receipts, periods, jobs, and accounting evidence. InfluxDB provides separate time-series network metrics. The worker projects observations conservatively and does not invent activation, connectivity, or period attribution. See [Provisioning](/docs/provisioning) and [RADIUS](/docs/radius).
