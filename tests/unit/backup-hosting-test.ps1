# Offline tests: mock PostgreSQL commands; never connect to hosting.
$ErrorActionPreference = 'Stop'
$backupScript = Join-Path $PSScriptRoot '..\..\bin\backup-hosting-database.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('berg-backup-test-' + [guid]::NewGuid().ToString('N'))
$names = @('HOSTING_PGSQL_HOST','HOSTING_PGSQL_PORT','HOSTING_PGSQL_USER','HOSTING_PGSQL_PASSWORD','HOSTING_PGSQL_DATABASE','PGPASSWORD','PGCONNECT_TIMEOUT')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
$global:backupDumpExit = 0
$global:backupRestoreExit = 0
$global:backupDumpCalls = 0
$global:backupDumpArguments = @()
function global:pg_dump {
    $global:backupDumpCalls++
    $global:backupDumpArguments = @($args)
    if ($env:PGPASSWORD -ne 'fake-password') { throw 'Password was not passed via environment' }
    $fileIndex = [Array]::IndexOf($global:backupDumpArguments, '--file')
    [IO.File]::WriteAllText($global:backupDumpArguments[$fileIndex + 1], 'fake archive')
    $global:LASTEXITCODE = $global:backupDumpExit
}
function global:pg_restore {
    if ($args[0] -ne '--list' -or $args.Count -ne 2) { throw 'Verification must only list a local archive' }
    $global:LASTEXITCODE = $global:backupRestoreExit
}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
    [IO.Directory]::CreateDirectory($temp) | Out-Null
    $env:HOSTING_PGSQL_HOST = 'example.invalid'
    $env:HOSTING_PGSQL_PORT = '5432'
    $env:HOSTING_PGSQL_USER = 'fake-user'
    $env:HOSTING_PGSQL_PASSWORD = 'fake-password'
    $env:HOSTING_PGSQL_DATABASE = 'fake-db'
    $env:PGPASSWORD = 'original-password'
    $env:PGCONNECT_TIMEOUT = '7'
    $output = Join-Path $temp 'nested\hosting.dump'
    & $backupScript -Output $output
    Assert (Test-Path -LiteralPath $output) 'Successful archive missing'
    Assert ($global:backupDumpArguments -contains '--format=custom') 'Expected custom archive'
    Assert (-not ($global:backupDumpArguments -contains '--schema')) 'Must dump the whole database'
    Assert (-not ($global:backupDumpArguments -contains 'fake-password')) 'Password leaked to arguments'
    Assert ($env:PGPASSWORD -eq 'original-password') 'Password environment not restored'
    Assert ($env:PGCONNECT_TIMEOUT -eq '7') 'Connection timeout not restored'
    $calls = $global:backupDumpCalls
    $failed = $false
    try { & $backupScript -Output $output } catch { $failed = $true }
    Assert $failed 'Existing backup must not be overwritten'
    Assert ($global:backupDumpCalls -eq $calls) 'Dump invoked for an existing destination'
    foreach ($failure in 'dump', 'verification') {
        $global:backupDumpExit = 0
        $global:backupRestoreExit = 0
        if ($failure -eq 'dump') { $global:backupDumpExit = 1 } else { $global:backupRestoreExit = 1 }
        $failedOutput = Join-Path $temp ($failure + '.dump')
        $failed = $false
        try { & $backupScript -Output $failedOutput } catch { $failed = $true }
        Assert $failed "Expected $failure failure"
        Assert (-not (Test-Path -LiteralPath $failedOutput)) 'Incomplete backup was published'
        Assert (@(Get-ChildItem -LiteralPath $temp -Recurse -Filter '*.partial').Count -eq 0) 'Partial backup was not removed'
        Assert ($env:PGPASSWORD -eq 'original-password') 'Password not restored after failure'
    }
    Write-Host 'Hosting backup offline tests: passed'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    Remove-Item Function:\pg_dump, Function:\pg_restore
    Remove-Variable backupDumpExit,backupRestoreExit,backupDumpCalls,backupDumpArguments -Scope Global
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
