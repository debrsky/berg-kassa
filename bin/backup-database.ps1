param(
    [string]$Output = (Join-Path $PSScriptRoot '..\backups\berg_kassa.dump'),
    [string[]]$Schemas = @('auth', 'vl')
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent

Get-Content (Join-Path $project '.env') | ForEach-Object {
    if ($_ -match '^([^#\s][^=]*)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($matches[1])) {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
}

foreach ($name in 'LOCAL_PGSQL_HOST','LOCAL_PGSQL_PORT','LOCAL_PGSQL_USER','LOCAL_PGSQL_PASSWORD','LOCAL_PGSQL_DATABASE') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment setting: $name" }
}

$outputPath = [IO.Path]::GetFullPath($Output)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
$arguments = @(
    '--host', $env:LOCAL_PGSQL_HOST, '--port', $env:LOCAL_PGSQL_PORT,
    '--username', $env:LOCAL_PGSQL_USER, '--dbname', $env:LOCAL_PGSQL_DATABASE,
    '--format=custom', '--no-owner', '--no-acl', '--file', $outputPath
)
foreach ($schema in $Schemas) { $arguments += @('--schema', $schema) }

$oldPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $env:LOCAL_PGSQL_PASSWORD
    & pg_dump @arguments
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
} finally {
    $env:PGPASSWORD = $oldPassword
}

Write-Host "Database backup created: $outputPath"
