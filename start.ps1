$ErrorActionPreference = 'Stop'
try {
    $ledgerInstalled = Join-Path $env:LOCALAPPDATA 'Programs\money-lab-local-ledger\超级账本.exe'
    $ledgerPortable = Join-Path $PSScriptRoot 'release\win-unpacked\超级账本.exe'
    $ledgerExe = if (Test-Path -LiteralPath $ledgerInstalled) { $ledgerInstalled } elseif (Test-Path -LiteralPath $ledgerPortable) { $ledgerPortable } else { $null }
    if (-not $ledgerExe) { throw '请先运行 release 文件夹中的「超级账本-安装-1.1.0.exe」。' }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $ledgerExe -WorkingDirectory (Split-Path -Parent $ledgerExe)
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host '按 Enter 关闭'
    exit 1
}
