## Prepare the router

ISPSense is intended to support MikroTik routers through their supported RouterOS capabilities, without tying the application to one model. Hardware capability, RouterOS version, and the configured service still need to be verified for each deployment.

Record the router identity, reachable management address, RouterOS version, intended Hotspot/PPPoE service, and the secure path between the router and the VPS.

## Management and customer access

Adding a device for management and monitoring is separate from enrolling it to authenticate customers and report accounting. A monitored router is not automatically an authorized network access server.

For PPPoE, discovery and saved service binding prepare the target server/profile/interface information. Pending binding is not proof of production admission.

## Accounting enrollment

The backend can prepare an accounting source for an existing router, using its actual RADIUS socket source IP, NAS identifier, and interim interval. New sources start disabled and require an audited administrator action to enable.

The source address must come from trusted RADIUS delivery. Do not substitute a customer-supplied attribute. Enrollment does not expose a UDP listener or enable production authorization.

## Current boundary

A complete dashboard-generated onboarding command and qualified production adapter are still required before claiming one-command customer onboarding. Do not run an improvised internet-facing router script from this guide.

Use [RADIUS and accounting](/docs/radius) and [Feature readiness](/docs/feature-readiness) to plan the remaining verification.
