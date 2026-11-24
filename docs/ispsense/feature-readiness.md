## Available in the dashboard

Customer numbers and profiles, packages for Hotspot/PPPoE, payment records and offline receipts, subscription preparation, access policy configuration, captive portal templates, AI configuration/chat, and in-dashboard alerts are implemented.

Device/MAC registration, connection limits, complimentary periods, speed overrides, schedules, and pause/vacation requests can be saved with history. Saving these requests is separate from enforcing them on a router.

## Background processing foundation

Durable provisioning jobs, bounded recovery, authenticated accounting ingestion for enrolled sources, packet deduplication, conservative session projection, and pipeline diagnostics are implemented. The local deployment runs the worker.

No production router adapter is registered. Expected pending work may show Waiting for router adapter. Accounting sources begin disabled.

## Requires router integration

Production customer authorization remains blocked. Effective activation, real disconnects, enforced speed/schedules/connection limits, and confirmed pause preservation need qualified router admission, inspection, fencing, and recovery.

Router discovery and PPPoE preparation do not replace these checks. A private protocol lab is not proof that real customer connectivity is ready.

## Requires integration verification

PayHero's hosted sandbox and production journey require provider credentials and acceptance checks. AI responses require an enabled connection, valid credentials, and a compatible model.

FUP configuration and deterministic evaluation are implemented; automatic warnings, exact period/reset-window accounting, and qualified network enforcement remain to be connected.

## Before a rollout

Verify the deployed application version and configuration against this guide, then run payment and router acceptance checks. Do not advertise an unverified capability as active service. See [Deployment](/docs/deployment) and [Troubleshooting](/docs/troubleshooting).
