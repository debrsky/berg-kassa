<#
.SYNOPSIS
Saves the entire hosting PostgreSQL database to a local custom-format archive.
.EXAMPLE
.\bin\backup-hosting-database.ps1
.EXAMPLE
.\bin\backup-hosting-database.ps1 -Output D:\Backups\hosting.dump
#>
param(
    [string]$Output = (Join-Path $PSScriptRoot ("..\backups\hosting_{0}.dump" -f (Get-Date -Format 'yyyyMMdd_HHmmss_fff')))
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $project '.env'

# Environment variables take precedence over the project's local .env.
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        if ($_ -match '^([^#\s][^=]*)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($matches[1])) {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
        }
    }
}
foreach ($name in 'HOSTING_PGSQL_HOST','HOSTING_PGSQL_PORT','HOSTING_PGSQL_USER','HOSTING_PGSQL_PASSWORD','HOSTING_PGSQL_DATABASE') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment setting: $name" }
}

$pgDump = Get-Command pg_dump -ErrorAction Stop
$pgRestore = Get-Command pg_restore -ErrorAction Stop
$outputPath = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw "Backup already exists; choose another output path: $outputPath" }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
# A failed dump is never published as a completed backup. Use the same directory
# so the final rename stays on the same volume, and never overwrite old backups.
$partialPath = $outputPath + '.' + [guid]::NewGuid().ToString('N') + '.partial'
$arguments = @(
    '--host', $env:HOSTING_PGSQL_HOST, '--port', $env:HOSTING_PGSQL_PORT,
    '--username', $env:HOSTING_PGSQL_USER, '--dbname', $env:HOSTING_PGSQL_DATABASE,
    '--no-password', '--format=custom', '--file', $partialPath
)

$oldPassword = $env:PGPASSWORD
$oldTimeout = $env:PGCONNECT_TIMEOUT
try {
    $env:PGPASSWORD = $env:HOSTING_PGSQL_PASSWORD
    $env:PGCONNECT_TIMEOUT = '30'
    & $pgDump @arguments
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE. Check access and client/server version compatibility." }
    if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf) -or (Get-Item -LiteralPath $partialPath).Length -eq 0) {
        throw 'pg_dump did not produce a non-empty archive.'
    }
    # Checks the archive table of contents only; this does not connect to a DB
    # and does not replace a full test restore in an isolated database.
    & $pgRestore '--list' $partialPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Archive verification failed with exit code $LASTEXITCODE" }
    [IO.File]::Move($partialPath, $outputPath)
} finally {
    $env:PGPASSWORD = $oldPassword
    $env:PGCONNECT_TIMEOUT = $oldTimeout
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
}

Write-Host "Hosting database backup created: $outputPath"
Write-Host ("Size: {0:N0} bytes" -f (Get-Item -LiteralPath $outputPath).Length)
