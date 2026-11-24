## Access periods

Billing → Subscriptions lists saved access periods. Access accounts expose the related identities and account state. Purchased and complimentary periods preserve their own funding and package terms.

An unstarted period is not currently usable access. Check funding, provisioning, activation, and expiry independently.

## Activation timing

Preparation can reserve an identity and proposed timing. Effective paid timestamps require confirmed access readiness. A router failure or uncertain response must not start a fresh paid clock or consume a duration that was never enabled.

Confirmed effective timestamps remain stable on retries. Original access dates remain in history; any confirmed pause adjustment is tracked separately.

## Renewals

A renewal preserves the predecessor and successor periods. Queuing a replacement is distinct from making it effective. Changes serialize per subscription/customer so retries do not create competing transitions.

Never assume a database update and router change happen atomically. Recover an uncertain provisioning result before retrying, and forfeit an existing entitlement only when its replacement becomes effective.

## Expiry and current readiness

Expiry is an entitlement boundary; network enforcement still depends on the qualified router integration. The production activation path remains gated. Existing historical records remain visible without creating a separate reporting environment.

See [Feature readiness](/docs/feature-readiness) and [Provisioning](/docs/provisioning) for the current implementation boundary.
