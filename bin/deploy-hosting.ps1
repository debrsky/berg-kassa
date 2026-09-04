$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent

Get-Content (Join-Path $project '.env') | ForEach-Object {
    if ($_ -match '^([^#\s][^=]*)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($matches[1])) {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
}

foreach ($name in 'FTP_KASSA_HOST','FTP_KASSA_PORT','FTP_KASSA_USER','FTP_KASSA_PASSWORD','HOSTING_PGSQL_HOST','HOSTING_PGSQL_PORT','HOSTING_PGSQL_USER','HOSTING_PGSQL_PASSWORD','HOSTING_PGSQL_DATABASE') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment setting: $name" }
}

$localSettings = @{
    LOCAL_PGSQL_HOST = $env:HOSTING_PGSQL_HOST
    LOCAL_PGSQL_PORT = $env:HOSTING_PGSQL_PORT
    LOCAL_PGSQL_USER = $env:HOSTING_PGSQL_USER
    LOCAL_PGSQL_PASSWORD = $env:HOSTING_PGSQL_PASSWORD
    LOCAL_PGSQL_DATABASE = $env:HOSTING_PGSQL_DATABASE
}
$previousSettings = @{}
try {
    foreach ($name in $localSettings.Keys) {
        $previousSettings[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $localSettings[$name], 'Process')
    }
    & (Join-Path $project '.tools\php\php.exe') (Join-Path $project 'bin\create-user.php')
    if ($LASTEXITCODE -ne 0) { throw "Database initialization failed with exit code $LASTEXITCODE" }
} finally {
    foreach ($name in $previousSettings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousSettings[$name], 'Process')
    }
}

$uploads = @(
    @{ Local = (Join-Path $project 'bin\create-user.php'); Remote = 'bin/create-user.php' },
    @{ Local = (Join-Path $project 'bin\prune-audit-log.php'); Remote = 'bin/prune-audit-log.php' }
)
Get-ChildItem (Join-Path $project 'src') -File -Filter '*.php' |
    Sort-Object @{ Expression = { $_.Name -eq 'app.php' } }, Name | ForEach-Object {
    $uploads += @{ Local = $_.FullName; Remote = "src/$($_.Name)" }
}
$publicRoot = (Resolve-Path (Join-Path $project 'public')).Path.TrimEnd('\')
Get-ChildItem $publicRoot -File -Recurse -Force |
    Where-Object Name -ne 'router.php' |
    ForEach-Object {
        $relative = $_.FullName.Substring($publicRoot.Length + 1).Replace('\', '/')
        $uploads += @{ Local = $_.FullName; Remote = "public_html/$relative" }
    }

Write-Warning 'FTP is not encrypted. The script never uploads .env or database passwords.'
$credentials = "${env:FTP_KASSA_USER}:${env:FTP_KASSA_PASSWORD}"
foreach ($upload in $uploads) {
    $uri = "ftp://$env:FTP_KASSA_HOST`:$env:FTP_KASSA_PORT/$($upload.Remote)"
    & curl.exe --silent --show-error --fail --ftp-create-dirs --user $credentials --upload-file $upload.Local $uri
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $($upload.Remote)" }
    Write-Host "Uploaded $($upload.Remote)"
}
