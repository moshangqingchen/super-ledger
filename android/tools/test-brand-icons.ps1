param([string]$Classes)
$ErrorActionPreference='Stop'
$Android=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if(!$Classes){
  $Build=Get-ChildItem -LiteralPath (Join-Path $Android 'build') -Directory | Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'classes\com\moneylab\superledger\mobile\BrandIcons.class')} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if(!$Build){throw 'Compile the actual Android production classes with android/build.ps1 before this visual policy regression.'}
  $Classes=Join-Path $Build.FullName 'classes'
}
$Output=Join-Path $Android ('build\brand-icons-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Output | Out-Null
$Classpath=$Classes+';'+(Join-Path $Android 'tools\lib\json-20240303.jar')+';'+(Join-Path $Android 'tools\sdk\android-35\android.jar')
& javac.exe '-J-Duser.language=en' '-encoding' 'UTF-8' '-cp' $Classpath '-d' $Output (Join-Path $Android 'app\src\test\java\com\moneylab\superledger\mobile\BrandIconsTest.java')
if($LASTEXITCODE -ne 0){throw 'Brand background regression compilation failed.'}
& java.exe '-Dfile.encoding=UTF-8' '-cp' ($Output+';'+$Classpath) 'com.moneylab.superledger.mobile.BrandIconsTest'
if($LASTEXITCODE -ne 0){throw 'Production brand background regression failed.'}
