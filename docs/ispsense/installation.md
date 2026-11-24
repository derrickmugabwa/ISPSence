## Prerequisites

Use a host with Docker and Docker Compose, persistent storage, and enough resources for PostgreSQL, Redis, InfluxDB, the backend, and nginx. Keep a copy of this customized ISPSense source; pulling an upstream image does not include these changes.

## Start the local installation

The current development stack uses the project name `isp-billing-dev` and a local environment file at `.local/manager.env`. Run commands from the project directory:

```sh
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml build backend nginx
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml up -d
```

This local environment file must already contain your installation settings. Do not copy example passwords into a public deployment or publish the environment file.

## Check the result

For the current local installation, open https://localhost:8443 and sign in with your existing administrator account. The actual address and ports depend on the environment and Compose configuration.

Use `docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml ps` to inspect container health. The backend applies its database migrations at startup.

## Continue setup

Follow [First setup](/docs), then [Feature readiness](/docs/feature-readiness). For a public server, use the separate [VPS deployment guide](/docs/deployment) before exposing the service.
