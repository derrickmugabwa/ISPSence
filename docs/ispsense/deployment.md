## Prepare the VPS

Use the customized ISPSense source and build its images. Choose your domain, TLS termination, persistent storage, backup destination, and secure network path to routers. Check the actual Compose port bindings before opening the service publicly.

Do not replace custom images with upstream MikroTik Manager images: that can omit ISPSense features and migrations. Keep the environment file and credentials out of version control.

## Move application state

Move the PostgreSQL database and preserve the installation's encryption keys with it. Include the required persistent volumes, application data, and configuration in the migration plan. Redis and InfluxDB have different roles from PostgreSQL; decide their retention and migration explicitly.

There is no reporting switch to change from local to live. Reports continue reading the saved database. Historical record provenance stays intact.

## Configure the boundary

Use valid HTTPS for the public application and callback origin. Set allowed browser origins for the deployed domain. When terminating TLS at another proxy, configure the documented proxy mode and trusted proxy addresses for this installation.

Keep internal database/cache/metrics services and the RADIUS bridge private. Router connectivity should use a deliberate trusted path, not broad public management exposure.

## Verify before rollout

Confirm container health, login, database migrations, backup restoration, source enrollment, and integration configuration. A healthy web service does not prove live customer admission, payment settlement, or FUP enforcement.

Use [Feature readiness](/docs/feature-readiness), [Backups](/docs/backups), and [Troubleshooting](/docs/troubleshooting) as rollout checkpoints. Deployment to a public VPS has not been completed by creating this guide.
