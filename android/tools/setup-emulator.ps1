$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Downloads = Join-Path $Root 'downloads'
$Sdk = Join-Path $Root 'sdk'
$Proxy = 'http://127.0.0.1:10090'
$Packages = @(
  @{Name='emulator-windows_x64-16740729.zip';Sha1='4d7268aa7787c640ad892844e6c9a5f159e91ad3';Base='https://dl.google.com/android/repository/';Check='emulator\emulator.exe';Target=$Sdk},
  @{Name='x86_64-35_r02.zip';Sha1='2d857d170c0d1b827149565da34b3383e5306f7f';Base='https://dl.google.com/android/repository/sys-img/android/';Check='x86_64\system.img';Target=(Join-Path $Sdk 'system-images\android-35\default')}
)
foreach($Package in $Packages) {
  $Archive = Join-Path $Downloads $Package.Name
  if(!(Test-Path -LiteralPath $Archive)) {
    & curl.exe --proxy $Proxy --connect-timeout 20 --max-time 1200 --fail --location --silent --show-error ($Package.Base + $Package.Name) --output ($Archive + '.part')
    if($LASTEXITCODE -ne 0) { throw ('Proxy download failed: ' + $Package.Name) }
    if((Get-FileHash -Algorithm SHA1 -LiteralPath ($Archive + '.part')).Hash -ne $Package.Sha1) { throw ('Checksum mismatch: ' + $Package.Name) }
    Move-Item -LiteralPath ($Archive + '.part') -Destination $Archive -Force
  }
  if((Get-FileHash -Algorithm SHA1 -LiteralPath $Archive).Hash -ne $Package.Sha1) { throw ('Checksum mismatch: ' + $Package.Name) }
  if(!(Test-Path -LiteralPath (Join-Path $Package.Target $Package.Check))) {
    New-Item -ItemType Directory -Path $Package.Target -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $Package.Target -Force
  }
}
Write-Output 'Official emulator 37.2.13 and AOSP Android 35 revision 2 are installed locally.'
