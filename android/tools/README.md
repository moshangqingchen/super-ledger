# Android offline build

This project uses Java/native Android widgets and the official standalone Android
build tools. It does not require Android Studio, Gradle, npm downloads, or a cloud
build service. Minimum Android API: 26. Compile/target API: 35.

From the project root in PowerShell:

```powershell
& .\android\tools\setup.ps1
& .\android\build.ps1 -Check
& .\android\build.ps1
```

Only `setup.ps1` downloads dependencies, explicitly through
`http://127.0.0.1:10090`. A failed proxy stops the download; there is no direct
fallback. `build.ps1` uses installed files and makes no network requests.

The output is `android/release/SuperLedger-Mobile-1.3.7.apk`, with a SHA-256
checksum file. The script compiles resources with AAPT2, Java with the installed
JDK, DEX with D8, aligns the APK, signs it with APK Signature Schemes v2/v3, and
verifies both the signature and alignment. No native `.so` files are included.

## Signing and updates

The first build creates a local, self-signed RSA signing identity in
`android/.signing/`. It is not a Play Store signing identity. That directory is
excluded from source control and its Windows ACL is limited to the current user
and SYSTEM. Passwords are passed by private file, never printed or placed on the
command line. Back up this directory privately: losing the signing key prevents
updating an installed app while preserving its local data. Never include it in
source archives or share it with the APK.

For later releases increment both the Android version name and version code:

```powershell
& .\android\build.ps1 -VersionName 1.3.7 -VersionCode 10307
```

## Dependency records and licenses

- `dependencies.json` records the exact official download URLs and checksums.
- Google SDK archives are verified against Google's repository SHA-1 checksums
  over HTTPS. Google's SDK license is retained in `licenses/android-sdk-license.txt`.
- ZXing core 3.5.3 was verified against Maven Central's SHA-1; the pinned SHA-256
  is checked on every build. Its Apache 2.0 license is retained alongside.
- The desktop QR encoder is vendored from Project Nayuki's official website,
  with its MIT license intact; no CDN is used at application runtime.

Reference documentation: [AAPT2](https://developer.android.com/tools/aapt2),
[D8](https://developer.android.com/tools/d8),
[APK signing](https://developer.android.com/tools/apksigner).

## Device validation

SDK/platform tools are in `android/tools/sdk/platform-tools/`. USB debugging and
device authorization must be enabled on the phone before using ADB. Building and
verifying an APK does not establish notification reliability on a vivo device;
that requires installation and testing with real transactions on the phone.

The offline QR interoperability test checks that the actual vendored desktop
encoder can be decoded by the same ZXing core used on Android:

```powershell
node .\android\tools\test-qr.cjs
```

The production `SyncClient`, `LedgerStore` and `PaymentParser` can also be compiled
on the build JDK with test-only adapters for Android platform classes:

```powershell
& .\android\tools\setup.ps1 -Tests
& .\android\tools\test-unit.ps1
node .\android\tools\test-android-interop.mjs
```

`test-unit.ps1` is fully offline after dependencies are installed. It compiles the
actual production business logic plus its Java main-based tests into a fresh
build directory, then runs `PaymentParserTest`, `PaymentRoutingTest`,
`PaymentPageParserTest`, `MobileLedgerTest`, `LedgerStoreTest` and
`UpdatePolicyTest`. The test output reports current counts. Receipt and page
fixtures are explicitly synthetic, not payment-app compatibility captures.
See [payment recognition scope](../../docs/payment-recognition.md) for default-off
accessibility behavior and the remaining real-device validation limits. The
integration script also runs these suites before local network tests.

This starts the real Node backend on an isolated test ledger and an existing
private IPv4 interface, then uses the actual Java client to pair, exchange
AES-GCM messages, send 500-operation batches, recover after lost acknowledgments,
and preserve/resolve simultaneous edits. It never contacts an external service.
The adapters and JSON test dependency are not packaged in the APK. Passing this
test validates protocol and Java business logic, not the Android UI, camera,
permissions, notification listener lifecycle or real-device battery behavior.

After signing an official update manifest, validate the exact public release
envelope and APK with the production Android verification policy:

```powershell
& .\android\tools\test-published-update.ps1 -Manifest .\updates\stable.json
```

This offline check uses the public key shipped in the Android resources and
validates the signed payload, APK size/SHA-256, same-version suppression and a
tampered signature. It does not read any release-signing private key, contact
GitHub, install the APK, or validate the Android installer UI.

## Emulator verification status

An official project-local Android Emulator 37.2.13 and AOSP Android 35 revision 2
system image were downloaded and checksum-verified through the configured proxy.
The optional download script is `setup-emulator.ps1`; these large SDK files stay
under the ignored `tools/sdk` and `tools/downloads` directories.

The attempted hidden emulator launch was **rejected by automatic execution
review** with only the reason `blocked by policy`. No emulator was started, and
no Android screenshots, camera tests, permission-flow tests, or runtime success
are claimed. The request had specified `restrict=on,ipv6=off` for both Wi-Fi and
radio user-mode networks (validated against the installed emulator help and AOSP
option parser), the existing HTTP proxy, `-no-metrics`, `-no-window`,
`-no-snapshot`, and `-no-audio`. Those planned isolation settings were not tested
in a running emulator. No global network, proxy, or firewall settings were changed.

The APK's resources/bytecode, package/SDK identity, signing, ZIP alignment, Java
unit tests and actual Java-to-Node protocol tests were validated separately.
Installation and testing on the user's vivo X200 Ultra are still required to
verify notifications, camera scanning and background behavior on that device.
