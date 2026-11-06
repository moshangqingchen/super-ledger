param([switch]$Force, [switch]$Tests)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Proxy = 'http://127.0.0.1:10090'
$Downloads = Join-Path $Root 'downloads'
$Sdk = Join-Path $Root 'sdk'
New-Item -ItemType Directory -Force -Path $Downloads,$Sdk,(Join-Path $Root 'lib') | Out-Null

# Pin packages from Google's signed HTTPS repository metadata. Every external
# request explicitly uses the user's proxy. curl never retries without it.
$Packages = @(
  @{Name='build-tools_r35_windows.zip';Sha1='af059bb67cf7786f45ee0db85e2d24985df1b4b6';Check='android-15\aapt2.exe'},
  @{Name='platform-35_r02.zip';Sha1='0bb560a90a7a2cbd0dd8348224d518b638fe7949';Check='android-35\android.jar'},
  @{Name='platform-tools_r37.0.1-win.zip';Sha1='e03e78b1d80b396f1c3358e31251cb31740e1110';Check='platform-tools\adb.exe'}
)
foreach($Package in $Packages) {
  $Archive = Join-Path $Downloads $Package.Name
  if($Force -or !(Test-Path -LiteralPath $Archive)) {
    & curl.exe --proxy $Proxy --connect-timeout 20 --max-time 1200 --fail --location --silent --show-error ('https://dl.google.com/android/repository/' + $Package.Name) --output ($Archive + '.part')
    if($LASTEXITCODE -ne 0) { throw ('Download failed through configured proxy: ' + $Package.Name) }
    if((Get-FileHash -Algorithm SHA1 -LiteralPath ($Archive + '.part')).Hash -ne $Package.Sha1) { throw ('Checksum mismatch: ' + $Package.Name) }
    Move-Item -LiteralPath ($Archive + '.part') -Destination $Archive -Force
  }
  if((Get-FileHash -Algorithm SHA1 -LiteralPath $Archive).Hash -ne $Package.Sha1) { throw ('Checksum mismatch: ' + $Package.Name) }
  if($Force -or !(Test-Path -LiteralPath (Join-Path $Sdk $Package.Check))) { Expand-Archive -LiteralPath $Archive -DestinationPath $Sdk -Force }
}
$Jar = Join-Path $Root 'lib\core-3.5.3.jar'
if($Force -or !(Test-Path -LiteralPath $Jar)) {
  & curl.exe --proxy $Proxy --connect-timeout 20 --max-time 120 --fail --location --silent --show-error 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar' --output ($Jar + '.part')
  if($LASTEXITCODE -ne 0) { throw 'ZXing download failed through configured proxy.' }
  # SHA-256 is recorded below after verification against Maven Central's SHA-1.
  $Checksum = (Get-Content -LiteralPath (Join-Path $Root 'dependencies.json') -Raw | ConvertFrom-Json).zxing.sha256
  if((Get-FileHash -Algorithm SHA256 -LiteralPath ($Jar + '.part')).Hash -ne $Checksum) { throw 'ZXing SHA-256 mismatch.' }
  Move-Item -LiteralPath ($Jar + '.part') -Destination $Jar -Force
}
Write-Output 'Android 35 SDK, build tools and ZXing are ready. Build stays offline.'
if($Tests) {
  $TestJar = Join-Path $Root 'lib\json-20240303.jar'
  $TestDependency = (Get-Content -LiteralPath (Join-Path $Root 'dependencies.json') -Raw | ConvertFrom-Json).testJson
  if($Force -or !(Test-Path -LiteralPath $TestJar)) {
    & curl.exe --proxy $Proxy --connect-timeout 20 --max-time 120 --fail --location --silent --show-error $TestDependency.url --output ($TestJar + '.part')
    if($LASTEXITCODE -ne 0) { throw 'JSON test dependency download failed through configured proxy.' }
    if((Get-FileHash -Algorithm SHA256 -LiteralPath ($TestJar + '.part')).Hash -ne $TestDependency.sha256) { throw 'JSON test dependency SHA-256 mismatch.' }
    Move-Item -LiteralPath ($TestJar + '.part') -Destination $TestJar -Force
  }
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $TestJar).Hash -ne $TestDependency.sha256) { throw 'JSON test dependency SHA-256 mismatch.' }
}
