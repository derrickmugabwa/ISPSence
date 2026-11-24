$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$schemaFile = Join-Path $projectRoot 'design\billing-schema.sql'
$checksFile = Join-Path $projectRoot 'design\billing-schema-checks.sql'
# DDL, identity sequences, and fixture DML belong to this transaction. No COMMIT.
$sqlText = "\set ON_ERROR_STOP on`nBEGIN;`nSET LOCAL lock_timeout = '3s';`nSET LOCAL statement_timeout = '20s';`n"
$sqlText += [System.IO.File]::ReadAllText($schemaFile)
$sqlText += "`n" + [System.IO.File]::ReadAllText($checksFile) + "`nROLLBACK;`n"
$sqlText | docker compose -p isp-billing-dev --env-file (Join-Path $projectRoot '.local\manager.env') -f (Join-Path $projectRoot 'docker-compose.yml') exec -T postgres psql -X -U mikrotik -d mikrotik_manager
if ($LASTEXITCODE -ne 0) { throw 'Draft billing schema validation failed; disconnected transaction rolls back.' }
Write-Output 'Validation complete. Draft schema and fake inventory row were rolled back.'
