param(
  [switch]$Check,
    [string]$VersionName = '1.3.4',
    [int]$VersionCode = 10304
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ActualRoot = $Root
$MappedDrive = $null
# Google's Windows AAPT2/zipalign use narrow path APIs. The user's project path
# contains Chinese characters, so use a temporary drive alias (no files move).
if($Root -match '[^\x00-\x7F]') {
  foreach($Letter in @('Z','Y','X','W','V','U','T','S','R','Q')) {
    if(!(Get-PSDrive -Name $Letter -ErrorAction SilentlyContinue) -and !(Test-Path -LiteralPath ($Letter+':\'))) {
      & subst.exe ($Letter+':') $Root
      if($LASTEXITCODE -ne 0) { throw 'Could not create temporary ASCII Android build path.' }
      $MappedDrive = $Letter+':'
      $Root = $MappedDrive+'\'
      break
    }
  }
  if(!$MappedDrive) { throw 'No unused drive letter is available for the temporary Android build path.' }
}
try {
$Tools = Join-Path $Root 'tools'
$BuildTools = Join-Path $Tools 'sdk\android-15'
$AndroidJar = Join-Path $Tools 'sdk\android-35\android.jar'
$Zxing = Join-Path $Tools 'lib\core-3.5.3.jar'
$Sources = Join-Path $Root 'app\src\main'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
function Run([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if($LASTEXITCODE -ne 0) { throw ('Build command failed ('+$LASTEXITCODE+'): '+[IO.Path]::GetFileName($Program)) }
}
function Need([string]$Filename) {
  if(!(Test-Path -LiteralPath $Filename -PathType Leaf)) { throw ('Missing offline dependency: '+$Filename+'. Run android/tools/setup.ps1 through the configured proxy first.') }
}
$Java = (Get-Command java.exe -ErrorAction Stop).Source
$JavaBin = Split-Path -Parent $Java
$Javac = Join-Path $JavaBin 'javac.exe'
$Jar = Join-Path $JavaBin 'jar.exe'
$Keytool = Join-Path $JavaBin 'keytool.exe'
$Aapt2 = Join-Path $BuildTools 'aapt2.exe'
$Zipalign = Join-Path $BuildTools 'zipalign.exe'
$D8 = Join-Path $BuildTools 'lib\d8.jar'
$Apksigner = Join-Path $BuildTools 'lib\apksigner.jar'
$LambdaStubs = Join-Path $BuildTools 'core-lambda-stubs.jar'
@($AndroidJar,$Zxing,$Javac,$Jar,$Keytool,$Aapt2,$Zipalign,$D8,$Apksigner,$LambdaStubs) | ForEach-Object { Need $_ }
$Deps = Get-Content -LiteralPath (Join-Path $Tools 'dependencies.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $Zxing -Algorithm SHA256).Hash -ne $Deps.zxing.sha256) { throw 'ZXing dependency checksum mismatch.' }
if($VersionName -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $VersionCode -lt 1) { throw 'Invalid Android version.' }
if($Check) { Write-Output 'Offline Android build preflight passed (Java, platform 35, build-tools 35, ZXing 3.5.3).'; exit 0 }

# A fresh build folder avoids stale bytecode without deleting previous artifacts.
$RunId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$Build = Join-Path $Root ('build\' + $RunId)
$Gen = Join-Path $Build 'generated'
$Classes = Join-Path $Build 'classes'
$Dex = Join-Path $Build 'dex'
$Release = Join-Path $Root 'release'
New-Item -ItemType Directory -Force -Path $Build,$Gen,$Classes,$Dex,$Release | Out-Null
$Compiled = Join-Path $Build 'resources.zip'
$Unsigned = Join-Path $Build 'unsigned.apk'
$Aligned = Join-Path $Build 'aligned.apk'
$Output = Join-Path $Release ('SuperLedger-Mobile-' + $VersionName + '.apk')
# Keep generated artwork byte-for-byte; AAPT2's default PNG processing can alter
# transparent pixels even when the source image itself is copied unchanged.
Run $Aapt2 @('compile','--no-crunch','--dir',(Join-Path $Sources 'res'),'-o',$Compiled)
Run $Aapt2 @('link','-o',$Unsigned,'-I',$AndroidJar,'--manifest',(Join-Path $Sources 'AndroidManifest.xml'),'--java',$Gen,'--min-sdk-version','26','--target-sdk-version','35','--version-code',([string]$VersionCode),'--version-name',$VersionName,'--auto-add-overlay',$Compiled)
$SourceFiles = @((Get-ChildItem -LiteralPath (Join-Path $Sources 'java') -Filter '*.java' -Recurse).FullName) + @((Get-ChildItem -LiteralPath $Gen -Filter '*.java' -Recurse).FullName)
if(!$SourceFiles.Count) { throw 'No Android Java sources found.' }
$SourceList = Join-Path $Build 'sources.txt'
[IO.File]::WriteAllLines($SourceList, [string[]]($SourceFiles | ForEach-Object { '"' + $_.Replace('\','/') + '"' }), $Utf8)
Run $Javac @('-J-Duser.language=en','-encoding','UTF-8','-source','8','-target','8','-bootclasspath',($AndroidJar+';'+$LambdaStubs),'-classpath',$Zxing,'-d',$Classes,('@'+$SourceList))
$ClassesJar = Join-Path $Build 'classes.jar'
Run $Jar @('--create','--file',$ClassesJar,'-C',$Classes,'.')
Run $Java @('-cp',$D8,'com.android.tools.r8.D8','--release','--min-api','26','--lib',$AndroidJar,'--output',$Dex,$ClassesJar,$Zxing)
foreach($DexFile in Get-ChildItem -LiteralPath $Dex -Filter '*.dex') { Run $Jar @('--update','--file',$Unsigned,'-C',$Dex,$DexFile.Name) }
Run $Zipalign @('-f','-P','16','4',$Unsigned,$Aligned)

# Keep this private directory when moving the project: the same signing identity
# is required for installing updates without deleting the app's local ledger.
$Signing = Join-Path $Root '.signing'
$Keystore = Join-Path $Signing 'superledger-mobile.p12'
$PasswordFile = Join-Path $Signing 'store-password.txt'
if(!(Test-Path -LiteralPath $Keystore)) {
  if(Test-Path -LiteralPath $PasswordFile) { throw 'Signing password exists but keystore is missing. Restore the signing backup before building an update.' }
  New-Item -ItemType Directory -Force -Path $Signing | Out-Null
  $Random = New-Object byte[] 32
  $Generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  $Generator.GetBytes($Random)
  $Generator.Dispose()
  [IO.File]::WriteAllText($PasswordFile,[Convert]::ToBase64String($Random),$Utf8)
  $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Signing '/inheritance:r' '/grant:r' ('*'+$CurrentSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0) { throw 'Could not restrict local signing directory.' }
  Run $Keytool @('-J-Duser.language=en','-genkeypair','-keystore',$Keystore,'-storetype','PKCS12','-storepass:file',$PasswordFile,'-keypass:file',$PasswordFile,'-alias','superledger-mobile','-keyalg','RSA','-keysize','3072','-sigalg','SHA256withRSA','-validity','10000','-dname','CN=SuperLedger Personal Android, OU=Local Development, O=Money Lab, C=CN','-noprompt')
}
Need $PasswordFile
Run $Java @('-jar',$Apksigner,'sign','--ks',$Keystore,'--ks-key-alias','superledger-mobile','--ks-pass',('file:'+$PasswordFile),'--v1-signing-enabled','false','--v2-signing-enabled','true','--v3-signing-enabled','true','--out',$Output,$Aligned)
Run $Java @('-jar',$Apksigner,'verify','--verbose','--print-certs',$Output)
Run $Zipalign @('-c','-P','16','4',$Output)
$ManifestReport = & $Aapt2 dump badging $Output
if($LASTEXITCODE -ne 0) { throw 'Packaged Android manifest inspection failed.' }
if(($ManifestReport -join "`n") -notmatch "package: name='com.moneylab.superledger.mobile'" -or ($ManifestReport -join "`n") -notmatch "sdkVersion:'26'" -or ($ManifestReport -join "`n") -notmatch "targetSdkVersion:'35'") { throw 'Packaged Android identity or SDK versions do not match the build contract.' }
if(!($ManifestReport -join "`n").Contains("versionCode='$VersionCode'") -or !($ManifestReport -join "`n").Contains("versionName='$VersionName'")) { throw 'Packaged Android release version does not match the requested version.' }
[IO.File]::WriteAllLines(($Output+'.manifest.txt'),[string[]]$ManifestReport,$Utf8)
$Hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($Output+'.sha256'),($Hash+'  '+[IO.Path]::GetFileName($Output)+[Environment]::NewLine),$Utf8)
Write-Output ('APK: '+(Join-Path $ActualRoot ('release\'+[IO.Path]::GetFileName($Output))))
Write-Output ('SHA256: '+$Hash)
} finally {
  if($MappedDrive) { & subst.exe $MappedDrive /d }
}
