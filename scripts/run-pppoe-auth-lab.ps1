param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$labProjectRoot = Split-Path -Parent $PSScriptRoot
$labDriver = 'isp-pppoe-auth-db-check'
$labWire = 'isp-pppoe-auth-wire-check'
$labVolume = 'isp-pppoe-auth-' + [Guid]::NewGuid().ToString('N')
$labVolumeCreated = $false
$labDriverAttempted = $false
function Invoke-LabDocker {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw ('PPPoE lab Docker operation failed: ' + $DockerArguments[0]) }
}
Push-Location $labProjectRoot
try {
    foreach ($labContainer in @($labDriver,$labWire)) {
        $labExisting = docker ps -a --filter "name=^/$labContainer`$" --format '{{.ID}}'
        if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable' }
        if ($labExisting) { throw "An existing test container named $labContainer must finish before another run" }
    }
    if (-not $SkipBuild) {
        Invoke-LabDocker -DockerArguments @('compose','-p','isp-billing-dev','--env-file','.local/manager.env','-f','docker-compose.yml','build','backend')
        Invoke-LabDocker -DockerArguments @('build','-f','radius/Dockerfile.pppoe-db-test','-t','isp-pppoe-db-protocol-check','radius')
    }
    Invoke-LabDocker -DockerArguments @('volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=uid=100,gid=101,mode=0770',$labVolume)
    $labVolumeCreated = $true
    $labDriverAttempted = $true
    Invoke-LabDocker -DockerArguments @('run','-d','--name',$labDriver,'--network','isp-billing-dev_data-network','--env-file','.local/manager.env',
        '-e','DATABASE_URL=postgresql://mikrotik@postgres:5432/mikrotik_manager','-v',"${labVolume}:/lab",
        '-v',"${labProjectRoot}/scripts/check-pppoe-auth.cjs:/app/check-pppoe-auth.cjs:ro",
        '-v',"${labProjectRoot}/scripts/check-pppoe-provisioning.cjs:/app/check-pppoe-provisioning.cjs:ro",
        '-v',"${labProjectRoot}/scripts/finish-pppoe-auth.cjs:/app/finish-pppoe-auth.cjs:ro",
        '-w','/app','isp-billing-dev-backend','node','check-pppoe-auth.cjs','--serve')
    Invoke-LabDocker -DockerArguments @('run','--rm','--name',$labWire,'--network',"container:$labDriver",'--cap-drop','ALL','--user','101:101','--read-only',
        '-v',"${labVolume}:/lab:ro",'--tmpfs','/tmp','--tmpfs','/var/log/freeradius:uid=101,gid=101,mode=0770',
        '--tmpfs','/var/run/freeradius:uid=101,gid=101,mode=0770','isp-pppoe-db-protocol-check')
    Invoke-LabDocker -DockerArguments @('exec',$labDriver,'node','finish-pppoe-auth.cjs')
    $labResult = docker wait $labDriver
    if ($LASTEXITCODE -ne 0 -or $labResult.Trim() -ne '0') { throw 'Database fixture did not complete successfully' }
} finally {
    if ($labDriverAttempted) {
        docker stop --timeout 20 $labDriver
        docker logs --tail 24 $labDriver
        docker rm $labDriver
    }
    if ($labVolumeCreated) { docker volume rm $labVolume }
    Pop-Location
}
