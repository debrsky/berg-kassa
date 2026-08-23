param(
    [string]$InputFile = (Join-Path $PSScriptRoot '..\backups\berg_kassa.dump'),
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent

Get-Content (Join-Path $project '.env') | ForEach-Object {
    if ($_ -match '^([^#\s][^=]*)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($matches[1])) {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
}

foreach ($name in 'HOSTING_PGSQL_HOST','HOSTING_PGSQL_PORT','HOSTING_PGSQL_USER','HOSTING_PGSQL_PASSWORD','HOSTING_PGSQL_DATABASE') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment setting: $name" }
}

$inputPath = [IO.Path]::GetFullPath($InputFile)
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Backup not found: $inputPath" }
$arguments = @(
    '--host', $env:HOSTING_PGSQL_HOST, '--port', $env:HOSTING_PGSQL_PORT,
    '--username', $env:HOSTING_PGSQL_USER, '--dbname', $env:HOSTING_PGSQL_DATABASE,
    '--no-owner', '--no-acl', '--exit-on-error'
)
if ($Replace) { $arguments += @('--clean', '--if-exists') }
$arguments += $inputPath

$oldPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $env:HOSTING_PGSQL_PASSWORD
    & pg_restore @arguments
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
} finally {
    $env:PGPASSWORD = $oldPassword
}

Write-Host 'Database restored on hosting.'
