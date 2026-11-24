# ISPSense

A self-hosted ISP billing and network operations application for MikroTik networks. Manage customers, packages, payments, access policies, and router operations from one dashboard.

ISPSense builds on [MikroTik Manager](https://github.com/2GT-Media-Group-LLC/mikrotik-manager). It retains the fleet management foundation and adds ISP billing workflows, configurable captive portals, and an AI assistant. Support is based on RouterOS capabilities and verified integrations rather than a single router model.

## Current status

The billing dashboard and preparation workflows are implemented. **Production customer internet authorization is not yet enabled:** no qualified production router adapter is registered. Saving a payment, subscription, speed policy, or access request does not establish that it has been enforced on a router.

| Area | Available | Remaining integration work |
| --- | --- | --- |
| Customers and packages | Customer numbers, profiles, Hotspot/PPPoE packages, frozen purchase terms | Router qualification for service delivery |
| Payments | Payment records, offline receipts, PayHero configuration, collection channels and bank channel registration | Credential-backed PayHero sandbox and production acceptance checks |
| Customer access | Complimentary periods, expiry/revocation requests, speed overrides/reset, suspend/resume, device/MAC registration, connection limits, selected-day/hour schedules, pause/vacation policies | Confirmed router enforcement and recovery, including remaining-time preservation |
| Sessions and provisioning | Stored session usage/history, durable jobs, authenticated accounting ingestion for enrolled sources, deduplication and diagnostics | Verified router admission, real disconnects, and current accounting evidence |
| Fair usage policy (FUP) | Policy configuration and deterministic evaluation | Automatic warnings, exact period/reset accounting, and network enforcement |
| AI assistant | Chat history, configurable providers/models, permission-checked read-only tools and streaming chat | Valid provider credentials and a compatible enabled model |
| Captive portals | Dashboard-managed templates, package display settings, checkout and payment demonstration pages | Verified payment-to-access journey |

See [feature readiness](docs/ispsense/feature-readiness.md) before planning a rollout. A private protocol lab does not establish production router readiness. Missing or stale accounting must not be interpreted as zero usage or proof that a customer is offline.

## Features

- **Billing overview:** collections, payment statuses, expiry, customer access states, and records needing attention, with date/package/payment-method filters.
- **Customer workspace:** contact details, customer number, payments, access periods, sessions, usage, policy settings, provisioning status, alerts, and audit history.
- **Access management:** paid and complimentary entitlements, customer speed overrides, devices and connection limits, scheduled access, and pause/vacation requests.
- **Portal customization:** configurable templates, package information, light/dark presentation, and separate checkout demonstration flows.
- **AI support:** dashboard configuration for model credentials and read-only investigation across saved billing and operational records. External AI requests use the configured provider.
- **Network operations:** inherited device monitoring, topology, backups, firmware workflows, configuration health, guarded changes, wireless management, and traffic analytics. Device capabilities and connectivity determine availability.
- **Public website and documentation:** responsive landing page, light/dark themes, and a searchable handbook at `/docs`.

Reports read the application's saved records; there is no separate live/simulation reporting selector. Historical source provenance is retained. Test fixtures and protocol labs are development utilities, not evidence of actual customer connectivity.

## Run locally

Use Docker Engine with Docker Compose and Linux containers. On Windows, start Docker Desktop's Linux engine. Run commands from the repository root.

1. Clone this repository and copy the environment template:

   ```sh
   git clone https://github.com/derrickmugabwa/ISPSence.git isp-billing
   cd isp-billing
   cp .env.example .env
   ```

   In PowerShell, use `Copy-Item .env.example .env` for the copy step.

2. Edit `.env` before the first start. For local development, set:

   ```dotenv
   HTTP_PORT=8080
   HTTPS_PORT=8443
   BIND_ADDRESS=127.0.0.1
   NETFLOW_BIND_ADDRESS=127.0.0.1
   CORS_ORIGIN=https://localhost:8443
   TZ=Africa/Nairobi
   ```

   Set unique values for `DB_PASSWORD`, `REDIS_PASSWORD`, and `INFLUXDB_TOKEN`; do not use the public defaults for a deployed installation. The application can generate and persist its signing/encryption keys on first startup. Preserve those keys with the database.

3. Build and start the customized source:

   ```sh
   docker compose -p isp-billing-dev up --build -d --wait --wait-timeout 240
   docker compose -p isp-billing-dev ps
   ```

4. Open **https://localhost:8443**. The local stack generates a self-signed certificate. On a fresh database, sign in with `admin` / `admin` and complete the required password change.

The source Dockerfiles supply their Node.js build/runtime environments. A host Node.js installation is only needed for host-side development commands and scripts.

### Existing local environment

If this checkout already uses `.local/manager.env`, continue using it and the same Compose project name to retain the existing installation's configuration and volumes:

```sh
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml up --build -d --wait --wait-timeout 240
```

`.env` and `.local/` are ignored by Git. Never commit real credentials or copy a local environment file into documentation.

### Stop and update

Stop services without deleting stored data:

```sh
docker compose -p isp-billing-dev stop
```

After reviewing and pulling source updates, rebuild the custom application images:

```sh
docker compose -p isp-billing-dev up -d --build backend nginx
```

Append `--env-file .local/manager.env -f docker-compose.yml` after the project name when using that environment. Migrations run at backend startup. Back up before upgrading; avoid `down --volumes` for routine shutdown.

**Do not replace the custom build with upstream prebuilt images.** The upstream image/Compose update path may omit ISPSense features and migrations.

## Deployment and persistence

The current application is a Docker Compose stack: frontend/nginx, Node.js backend, PostgreSQL, Redis, and InfluxDB. A VPS deployment needs a domain, valid HTTPS, persistent storage, backups, and a trusted network path to routers.

Preserve PostgreSQL and the installation's encryption keys together, along with required application data, certificates, and backups. Decide metrics retention separately. Keep internal database/cache/metrics services and the RADIUS bridge private. Configure allowed origins and trusted proxies for the deployment.

See [deployment](docs/ispsense/deployment.md), [configuration](docs/configuration.md), and [backups](docs/ispsense/backups.md). Starting the web application does not complete payment or router acceptance testing.

## Documentation

- [ISPSense handbook](docs/ispsense/README.md) - also available inside the app at `/docs`.
- [Feature readiness](docs/ispsense/feature-readiness.md) - implemented workflows and integration boundaries.
- [Packages](docs/ispsense/packages.md), [customers](docs/ispsense/customers.md), and [payments](docs/ispsense/payments.md).
- [Access management](docs/ispsense/access-management.md), [sessions](docs/ispsense/sessions.md), and [provisioning](docs/ispsense/provisioning.md).
- [Router onboarding](docs/ispsense/router-onboarding.md), [RADIUS](docs/ispsense/radius.md), and [PPPoE](docs/ispsense/pppoe.md).
- [PayHero](docs/ispsense/payhero.md) and [AI assistant](docs/ispsense/ai-assistant.md).
- [Inherited network/platform guides](docs/README.md) and [change protection](docs/change-guard.md).
- [`design/`](design/) - implementation plans and engineering decisions; plans are not feature-completion claims.

## Development and checks

| Directory | Purpose |
| --- | --- |
| `frontend/` | React/TypeScript dashboard, public pages, portal UI, and docs viewer |
| `backend/` | API, database migrations, billing modules, integrations, and workers |
| `nginx/` | Web serving, TLS, and API proxy |
| `docs/ispsense/` | Product handbook bundled into the frontend |
| `radius/` | Private RADIUS bridge/lab resources |
| `simulation/` | Isolated billing protocol tests and demonstration utilities |
| `scripts/` | Local diagnostics, smoke checks, and integration checks |

With dependencies installed in each package:

```sh
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend test -- --runInBand
npm --prefix frontend test
npm --prefix backend run build
npm --prefix frontend run build
node scripts/check-source-encoding.mjs
```

Run integration scripts only in an isolated local/test environment. Some create temporary records or exercise lifecycle transitions. Consult each script before running it; audit records may remain after fixture cleanup.

## Attribution and license

ISPSense is derived from MikroTik Manager, with the current foundation based on upstream commit `1d8f405ccb28db5e90a10d4c440fba916b84257e` (`0.54.0-beta`). Some internal package names and version metadata retain that upstream identity. Upstream attribution and license notices are preserved.

Licensed under [GNU AGPL v3.0](LICENSE). See the license for source-distribution and network-service obligations.

Not affiliated with or endorsed by MikroTik. MikroTik and RouterOS are trademarks of their respective owners.
