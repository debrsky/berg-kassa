$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent

Get-Content (Join-Path $project '.env') | ForEach-Object {
    if ($_ -match '^([^#\s][^=]*)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($matches[1])) {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
}

foreach ($name in 'FTP_KASSA_HOST','FTP_KASSA_PORT','FTP_KASSA_USER','FTP_KASSA_PASSWORD') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment setting: $name" }
}

$uploads = @(
    @{ Local = (Join-Path $project 'src\app.php'); Remote = 'src/app.php' },
    @{ Local = (Join-Path $project 'bin\create-user.php'); Remote = 'bin/create-user.php' }
)
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
