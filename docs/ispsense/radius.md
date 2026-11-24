## Trusted accounting delivery

Accounting observations must come through the authenticated internal bridge from an explicitly enabled router source. The source is identified by actual socket IP and NAS identifier. Event timestamps are required.

The public web listener blocks the internal bridge path. Source enrollment alone opens no network port and enables no customer login.

## Durable packet processing

Packets are saved before acknowledgement. Retransmissions are deduplicated, and projection writes the session, interval observation, and completion in one transaction. Temporary failures retry with backoff; packets are retained for attention after five failed projections.

Starts, interims, Stops, and NAS restart boundaries are handled conservatively. Missing Starts and counter resets remain unverified. Late packets cannot lower recorded counters or reopen a closed session.

## Diagnostics

Open Billing → RADIUS diagnostics to check the worker heartbeat, pending packets, packets needing attention, observed/stale/unmapped sessions, and source enrollment. Private lab records remain a separate section of that page.

## Authentication remains separate

Accounting is evidence about reported usage, not authorization or activation. The production authorization endpoint remains blocked. See [Session interpretation](/docs/sessions), [Provisioning](/docs/provisioning), and the [technical reference](/docs/api-reference).
