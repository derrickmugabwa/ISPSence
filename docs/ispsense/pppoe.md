## Persistent service identities

A PPPoE service belongs to a customer and keeps its identity across purchased periods. The customer number, service username, credential, and subscription ID serve different purposes.

Create the service from the customer profile. Choose a recognizable label and valid username, or allow the application to generate a username. Credential creation/reset is explicit; saved secrets are encrypted and are not ordinary directory fields.

## Packages and funding

Select a PPPoE-compatible package. A funding record snapshots the offer and prepares the corresponding period. It does not make an unfunded or unready period effective.

## Bind to the network

Router discovery and a saved binding describe the intended PPPoE server, interface, profile, and pool. Review the discovery result and provisioning history before changing a live subscriber's target.

## Production readiness

The private protocol lab exercises authentication and recovery with fictional fixtures. It does not enroll real customers into production. The production RADIUS authorization gate remains blocked until its adapter and access-readiness protocol are qualified.

You can prepare services and packages without the router. Authentication, addressing, traffic, disconnect behaviour, and policy enforcement require network verification. See [Provisioning](/docs/provisioning) and [RADIUS](/docs/radius).
