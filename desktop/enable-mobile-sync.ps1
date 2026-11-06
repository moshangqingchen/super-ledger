param(
  [string]$ProgramPath = (Join-Path $env:LOCALAPPDATA 'Programs\money-lab-local-ledger\超级账本.exe'),
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
# Only this application's inbound LAN access changes. No proxy, adapter, network
# category, outbound policy, or another program's rules are modified.
$ResolvedProgram = (Resolve-Path -LiteralPath $ProgramPath).Path
if ([IO.Path]::GetFileName($ResolvedProgram) -ne '超级账本.exe') { throw '请选择超级账本.exe。' }
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请以管理员身份运行此脚本，仅添加超级账本的局域网入站规则。' }
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $Digest = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($ResolvedProgram.ToLowerInvariant()))).Replace('-','').Substring(0,16) } finally { $Hasher.Dispose() }
$RuleName = 'SuperLedger-MobileSync-LAN-' + $Digest
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Remove) {
  if ($Existing) { $Existing | Remove-NetFirewallRule }
  Write-Output '已移除此程序的手机同步规则。'
  exit 0
}
if (!$Existing) {
  New-NetFirewallRule -Name $RuleName -DisplayName '超级账本 · 手机扫码同步（仅本地子网）' -Description '仅允许本地子网访问超级账本临时加密同步端口；不开放公网入站。' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -Program $ResolvedProgram -LocalAddress @('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16') -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
}
Write-Output ('局域网同步规则已就绪：' + $ResolvedProgram)
