[CmdletBinding()]
param(
    [switch]$Dir,
    [switch]$Check,
    [string]$ToolRoot
)

$ErrorActionPreference = 'Stop'
$ledgerRoot = $PSScriptRoot
$ledgerToolRootBefore = [Environment]::GetEnvironmentVariable('LEDGER_DESKTOP_TOOLROOT', 'Process')
$ledgerExitCode = 1
Push-Location -LiteralPath $ledgerRoot
try {
    if ($ToolRoot) { $env:LEDGER_DESKTOP_TOOLROOT = $ToolRoot }
    $ledgerNode = (Get-Command node.exe -ErrorAction Stop).Source
    $ledgerBuildArgs = @()
    if ($Dir) { $ledgerBuildArgs += '--dir' }
    if ($Check) { $ledgerBuildArgs += '--check' }
    & $ledgerNode (Join-Path $ledgerRoot 'desktop\build.cjs') @ledgerBuildArgs
    $ledgerExitCode = $LASTEXITCODE
} catch {
    Write-Error $_.Exception.Message
} finally {
    [Environment]::SetEnvironmentVariable('LEDGER_DESKTOP_TOOLROOT', $ledgerToolRootBefore, 'Process')
    Pop-Location
}
exit $ledgerExitCode
