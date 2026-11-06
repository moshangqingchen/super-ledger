param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [string]$Apk,
  [long]$PreviousCode = -1
)
$ErrorActionPreference = 'Stop'
$Tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$Android = Split-Path -Parent $Tools
if(!$Apk) { $Apk = Join-Path $Android 'release\SuperLedger-Mobile-1.3.0.apk' }
$Source = Join-Path $Android 'app\src\main\java\com\moneylab\superledger\mobile\UpdatePolicy.java'
$Key = Join-Path $Android 'app\src\main\res\raw\update_public_key.der'
$Jar = Join-Path $Tools 'lib\json-20240303.jar'
$Dependency = (Get-Content -LiteralPath (Join-Path $Tools 'dependencies.json') -Raw | ConvertFrom-Json).testJson
foreach($Required in @($Manifest,$Apk,$Source,$Key,$Jar)) { if(!(Test-Path -LiteralPath $Required -PathType Leaf)) { throw ('Missing update test input: '+$Required) } }
if((Get-FileHash -Algorithm SHA256 -LiteralPath $Jar).Hash -ne $Dependency.sha256) { throw 'JSON test dependency checksum mismatch.' }
$Output = Join-Path $Android ('build\published-update-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Output | Out-Null
& javac.exe '-J-Duser.language=en' '-encoding' 'UTF-8' '-cp' $Jar '-d' $Output $Source (Join-Path $Tools 'VerifyPublishedAndroidUpdate.java')
if($LASTEXITCODE -ne 0) { throw 'Update verifier compilation failed.' }
$VerifyArgs = @('-Dfile.encoding=UTF-8', '-cp', ($Output+';'+$Jar), 'VerifyPublishedAndroidUpdate', ([IO.Path]::GetFullPath($Manifest)), $Key, ([IO.Path]::GetFullPath($Apk)))
if($PreviousCode -ge 0) { $VerifyArgs += [string]$PreviousCode }
& java.exe @VerifyArgs
if($LASTEXITCODE -ne 0) { throw 'Production update manifest validation failed.' }
