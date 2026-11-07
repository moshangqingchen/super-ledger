$ErrorActionPreference = 'Stop'
$Tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$Android = Split-Path -Parent $Tools
$Source = Join-Path $Android 'app\src\main\java\com\moneylab\superledger\mobile'
$Tests = Join-Path $Android 'app\src\test\java\com\moneylab\superledger\mobile'
$JsonJar = Join-Path $Tools 'lib\json-20240303.jar'
if(!(Test-Path -LiteralPath $JsonJar)) { throw 'Missing test dependency. Run android/tools/setup.ps1 -Tests through the configured proxy first.' }
$Dependency = (Get-Content -LiteralPath (Join-Path $Tools 'dependencies.json') -Raw | ConvertFrom-Json).testJson
if((Get-FileHash -Algorithm SHA256 -LiteralPath $JsonJar).Hash -ne $Dependency.sha256) { throw 'JSON test dependency checksum mismatch.' }
$Output = Join-Path $Android ('build\unit-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Sources = @(
  (Join-Path $Source 'PaymentParser.java'),
  (Join-Path $Source 'PaymentRouting.java'),
  (Join-Path $Source 'PaymentPageParser.java'),
  (Join-Path $Source 'MobileLedger.java'),
  (Join-Path $Source 'AppleBalance.java'),
  (Join-Path $Source 'SubscriptionDetails.java'),
  (Join-Path $Source 'LedgerStore.java'),
  (Join-Path $Source 'SyncClient.java'),
  (Join-Path $Source 'UpdatePolicy.java'),
  (Join-Path $Source 'UpdatePresentation.java'),
  (Join-Path $Source 'UpdateTransport.java'),
  (Join-Path $Source 'UpdateSources.java'),
  (Join-Path $Source 'UpdateSourceClient.java'),
  (Join-Path $Tests 'PaymentParserTest.java'),
  (Join-Path $Tests 'PaymentRoutingTest.java'),
  (Join-Path $Tests 'PaymentPageParserTest.java'),
  (Join-Path $Tests 'MobileLedgerTest.java'),
  (Join-Path $Tests 'SubscriptionDetailsTest.java'),
  (Join-Path $Tests 'SubscriptionRenewalTest.java'),
  (Join-Path $Tests 'LedgerStoreTest.java'),
  (Join-Path $Tests 'UpdatePolicyTest.java'),
  (Join-Path $Tests 'UpdatePresentationTest.java'),
  (Join-Path $Tests 'UpdateTransportTest.java'),
  (Join-Path $Tests 'UpdateSourcesTest.java'),
  (Join-Path $Tests 'UpdateSourceClientTest.java')
)
foreach($Stub in @('android\content\Context.java','android\os\Build.java','android\util\AtomicFile.java','android\util\Base64.java')) { $Sources += Join-Path $Tools ('test-stubs\'+$Stub) }
& javac.exe '-J-Duser.language=en' '-encoding' 'UTF-8' '-cp' $JsonJar '-d' $Output @Sources
if($LASTEXITCODE -ne 0) { throw 'Android unit-test compilation failed.' }
foreach($Class in @('PaymentParserTest','PaymentRoutingTest','PaymentPageParserTest','MobileLedgerTest','SubscriptionDetailsTest','SubscriptionRenewalTest','LedgerStoreTest','UpdatePolicyTest','UpdatePresentationTest','UpdateTransportTest','UpdateSourcesTest','UpdateSourceClientTest')) {
  & java.exe '-Dfile.encoding=UTF-8' '-cp' ($Output+';'+$JsonJar) ('com.moneylab.superledger.mobile.'+$Class)
  if($LASTEXITCODE -ne 0) { throw ('Android Java unit test failed: '+$Class) }
}
Write-Output 'Unit tests use actual Java business logic with JDK platform adapters; they do not validate Android runtime behavior.'
