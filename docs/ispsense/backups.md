## Back up the application

Keep a consistent PostgreSQL backup together with the installation's encryption keys and required configuration. Encrypted stored router, payment, and AI credentials may be unusable if the database is restored without its original keys.

Include the persistent files and metrics retention your business needs. Keep an inventory of the relevant Docker volumes and paths for the actual deployed Compose configuration.

## Router backups are separate

The dashboard's device Backups feature captures RouterOS configuration exports. A router export is not a backup of the ISPSense database, receipts, customer records, or encryption keys.

A readable RouterOS export also does not necessarily include passwords, certificates, or all files on the device. Plan device recovery separately.

## Verify recovery

Restore a backup into an isolated environment. Check representative customer/payment records, credential readability, and application health before relying on the backup procedure.

Avoid pointing a restored test installation at production routers or enabling payment collections accidentally. Keep external integrations disabled while validating recovery.

## Before an upgrade

Take a recoverable snapshot and retain the custom source and image versions. Review migrations and the deployment procedure; do not assume an upstream pull preserves ISPSense changes. See [Deployment](/docs/deployment).
