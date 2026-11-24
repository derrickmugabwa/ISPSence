## Requested versus effective

Saving an access change creates requested policy. The provisioning worker retains work in PostgreSQL across restarts. It reports pending state without claiming that the network changed.

## Read worker states

- **Queued:** discovered work waiting for processing.
- **Waiting for router adapter:** no qualified adapter can apply this kind of request yet.
- **Applying:** an operation has been claimed with a bounded lease.
- **Verifying:** a result is being inspected; acknowledgement is not confirmation.
- **Uncertain:** an operation may have happened. Inspect the same generation before retrying.
- **Retry:** a definite non-application with a retired generation permits another attempt.
- **Confirmed:** matching fresh evidence establishes the operation's result.
- **Attention:** the bounded recovery limit has been reached and needs investigation.
- **Superseded:** another request replaced this work.

## Recovery rules

The worker serializes customer changes and ignores stale lease writers. An adapter must enforce version/generation fences at the network boundary. A timeout does not prove a command failed.

The generic worker does not activate paid periods or make renewals effective. Those transitions require the separate access-readiness protocol. A confirmed generic job alone does not establish every aspect of effective customer access.

## Where to investigate

Open the customer's Manage access → Provisioning, review changes and alerts, and inspect Billing → RADIUS diagnostics for pipeline health. Do not repeatedly submit policy changes to clear an uncertain result.
