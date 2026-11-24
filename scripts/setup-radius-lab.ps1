$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $projectRoot '.local/manager.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Initialize the local app environment first.' }
$envText = [System.IO.File]::ReadAllText($envPath)
foreach ($name in @('RADIUS_BRIDGE_TOKEN','RADIUS_LAB_SECRET')) {
    if ($envText -notmatch "(?m)^$name=.+$") {
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $value = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $envText += "`n$name=$value`n"
    }
}
[System.IO.File]::WriteAllText($envPath,$envText,(New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Private RADIUS lab secrets are configured; values are not displayed.'
