## Find session history

Open Billing → Customer sessions, or the Sessions tab in a customer profile. Search and filter saved observations, inspect transfer totals, and review available event history.

Download and upload are cumulative byte counters from the customer's perspective. They describe transferred data, not an instantaneous speed measurement.

## Interpret quality and freshness

A zero-counter Start followed by ordered monotonic observations establishes a complete accounting baseline. Missing Starts, clock skew, counter resets, and reused session identities require caution.

A recent observation, stale session, closed session, and unknown connection are different states. A saved open session cannot guarantee that the customer is online right now. Missing observations must not be presented as zero usage.

## Customer and period attribution

The pipeline may associate a session with a service when its username and saved router binding match. It does not infer a paid period from a username alone. Subscription and payment references can therefore be absent on real accounting observations.

Historical test records retain their original provenance in the shared database. They are not relabelled as router observations.

## Bandwidth and disconnects

Router interface throughput uses separate network metrics. Session totals cannot substitute for those measurements. Disconnect controls create requested work; inspect provisioning confirmation before declaring that the session ended.

Exact FUP reset-window attribution and automatic enforcement remain separate work. See [FUP](/docs/fup).
