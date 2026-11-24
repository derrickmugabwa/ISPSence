# Durable network processing

The application starts a single-flight scheduler with the backend. PostgreSQL retains pending packets, provisioning runs, leases and fixed-code events across restarts. Multiple backend processes use row locks and customer locks to coordinate claims.

## Provisioning

Existing pending access jobs are discovered without changing the requested policy. With no qualified router adapter, runs become `waiting_adapter` and do not consume attempts. No production adapter is registered yet.

With a qualified adapter, a run moves through `applying`, `verifying`, and `confirmed`. An acknowledgement only starts verification. A timeout, exception, or expired lease requires inspection of the same generation. Only exact, fresh evidence matching job, scope, version and generation confirms application. Definite non-application requires proof the generation was retired before another application attempt. Five definite failures or twenty inconclusive inspections require attention. Unknown work blocks other changes for the same customer.

The adapter must persist version/generation fences at the network boundary and reject stale commands. A database lease or an abort signal alone cannot prevent a delayed router operation. Superseded jobs are fenced by that adapter contract; no real adapter may be enabled without proving this property.

Activation and renewals stay behind the existing access-readiness protocol. This generic worker cannot apply them, start paid time, update effective subscription timestamps, or forfeit an old entitlement. Confirming a generic job does not by itself update effective customer runtime state; each qualified adapter still needs its policy-specific reconciliation.

## Accounting

Fleet administrators can prepare a source with `POST /api/billing/radius/sources` using `device_id`, the actual socket `source_ip`, `nas_identifier`, `interim_seconds` (30–3600), and an audit `reason`. Sources start disabled. `PUT /api/billing/radius/sources/:id/status` requires `enabled`, the current `version`, and `reason`.

The protected bridge accepts parsed packets at `POST /internal/radius/observations`. It requires its existing bearer credential, an enabled exact source/IP and NAS identifier, and an Event-Timestamp. The bridge must populate the source IP from the RADIUS socket, never a customer-supplied attribute. The public nginx listener blocks `/internal/`; enrollment does not open UDP ports or enable authentication. `/internal/radius/authorize` remains blocked. The older loopback lab endpoint remains private and separate.

Packets commit to an inbox before acknowledgment. Canonical fingerprints deduplicate retransmissions. Processing atomically saves the session, interval observation and inbox completion. Failure rolls back that projection, backs off, and holds a packet for attention after five failures. A disabled source pauses its retained packets.

A zero-counter Start establishes a complete baseline. Ordered monotonic observations yield byte deltas; missing Starts, counter resets, reused sessions, and clock skew remain unverified. Late packets cannot lower counters or reopen closed sessions. Accounting-On/Off creates a new source epoch; observations predating that boundary cannot recreate an old session. Missing observations never mean zero usage.

An exact username and saved router binding may associate a session with a customer service. The pipeline never assigns a paid period from a username alone. Shared session history reports observed counters, quality and freshness, with nullable subscription/payment data. An observed or stale session is not proof of current connectivity.

## Operations and remaining work

`GET /api/billing/radius/pipeline` and RADIUS diagnostics expose backlog, attention counts, source enrollment, stale/unmapped sessions, worker states and heartbeat. Customer job history and the existing AI provisioning tool expose worker state and attempt counts. Raw adapter exceptions and credentials are not stored in job events.

Before enabling a real router: qualify generation fencing and inspection, implement policy-specific reconciliation, configure trusted RADIUS delivery, and verify authentication/readiness on a router. Automatic FUP enforcement still needs verified period correlation and exact reset-window attribution; the current interval observations must not be prorated into billable usage. High-volume production also needs an explicit evidence-retention/rollup policy and capacity measurement. No inbox or accounting evidence is automatically deleted.

Verification: focused Jest suites plus `scripts/check-network-pipeline.cjs` in a disposable PostgreSQL schema, using fictional records and a controlled adapter. No router or payment-provider calls are made by these checks.
