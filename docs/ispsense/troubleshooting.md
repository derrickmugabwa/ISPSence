## A customer has paid but cannot connect

Check the confirmed receipt and customer reference, then inspect the period's activation and provisioning state. A successful payment is not proof of access readiness. If work is waiting for the router adapter, another payment will not resolve it.

## A session looks active but the customer is offline

Inspect observation freshness, accounting quality, and the last received event. A missing Stop may leave a saved session open. Compare available router metrics; do not equate an old record with current connectivity.

## Usage is missing or lower than expected

Check the enabled source, NAS identity, trusted delivery, pending packets, and attention counts in RADIUS diagnostics. Missing Starts or counter resets leave usage unverified. Session counters do not necessarily identify a paid period or an exact FUP window.

## A saved change has not taken effect

Review the requested policy and provisioning events. Uncertain operations require inspection; blind retries can conflict with an operation that already reached the router. See [Provisioning states](/docs/provisioning).

## A payment or AI connection test fails

Check the selected environment/provider, origin, credential revision, and model/channel. Never paste secret keys into chat or screenshots. A successful catalogue/channel test does not prove the full transaction or generation flow.

## The application does not load

Check container health, proxy/TLS settings, recent migration failures, and the actual bound port. Use logs appropriate to the affected service and redact secrets before sharing them. For deployment and restoration, see [Deployment](/docs/deployment) and [Backups](/docs/backups).
