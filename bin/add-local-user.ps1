param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Login,

    [Parameter(Position = 1)]
    [string[]]$Schemas = 'vl',

    [Parameter(Position = 2)]
    [ValidateSet(0, 1)]
    [int]$Protected = 0
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$php = Join-Path $project '.tools\php\php.exe'
if (-not (Test-Path -LiteralPath $php -PathType Leaf)) { $php = 'php' }

$oldPassword = $env:NEW_USER_PASSWORD
try {
    $password = Read-Host 'Password' -AsSecureString
    $env:NEW_USER_PASSWORD = [Net.NetworkCredential]::new('', $password).Password
    & $php (Join-Path $PSScriptRoot 'create-user.php') $Login ($Schemas -join ',') $Protected
    if ($LASTEXITCODE -ne 0) { throw "create-user.php failed with exit code $LASTEXITCODE" }
} finally {
    $env:NEW_USER_PASSWORD = $oldPassword
}
