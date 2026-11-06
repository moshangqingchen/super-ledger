package com.moneylab.superledger.mobile;

import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/** Offline tests of the exact verification policy used by the Android updater. */
public final class UpdatePolicyTest {
    private static int checks;
    private static KeyPair keys;
    private static final byte[] CONTENT = "test APK bytes, no network or real installer".getBytes(StandardCharsets.UTF_8);
    private static final String CERTIFICATE = "fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785";
    private interface Throwing { void run() throws Exception; }
    private static void check(boolean condition, String label) { checks++; if (!condition) throw new AssertionError(label); }
    private static void rejects(Throwing work, String label) throws Exception { boolean rejected = false; try { work.run(); } catch (Exception expected) { rejected = true; } check(rejected, label); }
    private static void rejectsAs(Class<?> type, Throwing work, String label) throws Exception { try { work.run(); throw new AssertionError(label); } catch (Exception error) { check(type.isInstance(error), label); } }
    private static JSONObject manifest() throws Exception {
        return new JSONObject().put("schema", 1).put("repository", UpdatePolicy.REPOSITORY).put("publishedAt", "2026-11-06T12:00:00.000Z")
            .put("android", new JSONObject().put("version", "1.1.0").put("versionCode", 10100).put("url", "https://github.com/" + UpdatePolicy.REPOSITORY + "/releases/download/v1.6.0/SuperLedger-Mobile-1.1.0.apk")
                .put("sha256", UpdatePolicy.sha256(CONTENT)).put("size", CONTENT.length).put("notes", "安全更新测试").put("packageName", UpdatePolicy.PACKAGE_NAME).put("certificateSha256", CERTIFICATE).put("minSdk", 26));
    }
    private static byte[] envelope(JSONObject manifest) throws Exception {
        byte[] payload = manifest.toString().getBytes(StandardCharsets.UTF_8); Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(keys.getPrivate()); signer.update(payload);
        return new JSONObject().put("schema", 1).put("payload", Base64.getEncoder().encodeToString(payload)).put("signature", Base64.getEncoder().encodeToString(signer.sign())).toString().getBytes(StandardCharsets.UTF_8);
    }
    private static UpdatePolicy.Release verify(JSONObject data) throws Exception { return UpdatePolicy.verify(envelope(data), keys.getPublic(), 10000, 35); }
    private static void openingChecks() throws Exception {
        UpdatePolicy.OpenLifecycle lifecycle = new UpdatePolicy.OpenLifecycle();
        check(lifecycle.onStart(), "cold start requests one automatic check");
        check(!lifecycle.onStart(), "duplicate onCreate/onStart callback does not request twice");
        lifecycle.onStop(true);
        check(!lifecycle.onStart(), "rotation or permission activity return does not request again");
        lifecycle.onStop(false);
        check(!lifecycle.onLauncherIntent(), "launcher intent before onStart waits for the same opening");
        check(lifecycle.onStart() && !lifecycle.onStart(), "background reopen and launcher intent coalesce into one check");
        check(lifecycle.onLauncherIntent() && !lifecycle.onStart(), "explicit launcher intent while started checks once without another start check");
        lifecycle.onStop(true);
        check(!lifecycle.onLauncherIntent() && lifecycle.onStart(), "explicit launcher reopen overrides temporary child-activity suppression");
        lifecycle.onStop(true); lifecycle.onStop(false);
        check(!lifecycle.onStart(), "duplicate stop cannot reclassify a temporary return");
        lifecycle.onStop(false);
        check(lifecycle.onStart(), "later real background reopening checks even after temporary returns");

        long now = 1000000000L;
        UpdatePolicy.CheckGate gate = new UpdatePolicy.CheckGate();
        check(!gate.request(UpdatePolicy.CheckReason.OPEN, true, now, now), "opening during cache restore waits");
        check(!gate.request(UpdatePolicy.CheckReason.MANUAL, true, now, now), "manual check during restore joins pending request");
        check(!gate.request(UpdatePolicy.CheckReason.PERIODIC, true, now, now), "periodic request does not weaken pending immediate check");
        check(gate.restored() == UpdatePolicy.CheckReason.MANUAL, "restore releases only one immediate request");
        check(gate.restored() == null, "restore request is consumed once");
        check(gate.request(UpdatePolicy.CheckReason.MANUAL, false, now, now), "queued manual request bypasses interval");
        check(!gate.request(UpdatePolicy.CheckReason.OPEN, false, now, now), "overlapping reopening shares in-flight manual check");
        check(!gate.request(UpdatePolicy.CheckReason.MANUAL, false, now, now), "overlapping manual requests share in-flight check");
        gate.finished();
        check(!gate.request(UpdatePolicy.CheckReason.PERIODIC, false, now, now), "periodic requests retain six-hour interval");
        check(gate.request(UpdatePolicy.CheckReason.OPEN, false, now, now), "new opening bypasses recent successful-check interval");
        gate.finished();
        check(!gate.request(UpdatePolicy.CheckReason.OPEN, true, now, now), "opening does not interrupt download or installation");
        check(!gate.request(UpdatePolicy.CheckReason.MANUAL, true, now, now), "manual checks also respect active download or installation");
        check(gate.restored() == null, "protected-operation request does not leave a surprise queued check");
        check(gate.request(UpdatePolicy.CheckReason.PERIODIC, false, now, now - 6L * 60 * 60 * 1000), "periodic request runs after six hours");
        gate.finished();

        UpdatePolicy.CheckGate concurrent = new UpdatePolicy.CheckGate();
        check(concurrent.restored() == null, "initialization without an opening creates no network work");
        CountDownLatch start = new CountDownLatch(1); AtomicInteger winners = new AtomicInteger(); Thread[] callers = new Thread[12];
        for (int index = 0; index < callers.length; index++) {
            final UpdatePolicy.CheckReason reason = index % 2 == 0 ? UpdatePolicy.CheckReason.OPEN : UpdatePolicy.CheckReason.MANUAL;
            callers[index] = new Thread(() -> {
                try { start.await(); if (concurrent.request(reason, false, now, now)) winners.incrementAndGet(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }); callers[index].start();
        }
        start.countDown(); for (Thread caller : callers) caller.join(2000);
        for (Thread caller : callers) if (caller.isAlive()) throw new AssertionError("Concurrent check did not terminate");
        check(winners.get() == 1, "simultaneous manual and open requests start exactly one check");
        concurrent.finished();
        check(concurrent.request(UpdatePolicy.CheckReason.OPEN, false, now, now), "completed check permits a later explicit opening");
        concurrent.finished();
    }
    private static void recoveryChecks() {
        UpdatePolicy.InstallPermission permission = new UpdatePolicy.InstallPermission();
        check(!permission.isWaiting() && !permission.returned(), "old permission result cannot begin installation without this process owning the request");
        check(permission.begin() && permission.isWaiting(), "explicit install permission launch owns one pending request");
        check(!permission.begin(), "permission request is not launched twice");
        permission.cancel();
        check(!permission.isWaiting() && !permission.returned(), "failed permission activity launch releases check/install protection");
        check(permission.begin() && permission.returned() && !permission.returned(), "permission result can continue only its one explicit installation request");
        permission.begin();
        check(!new UpdatePolicy.InstallPermission().isWaiting(), "new process cannot inherit an orphaned permission wait");
        UpdatePolicy.CheckGate gate = new UpdatePolicy.CheckGate(); gate.restored();
        check(!gate.request(UpdatePolicy.CheckReason.OPEN, permission.isWaiting(), 1000, 999), "actual permission ownership protects installation from an opening check");
        permission.cancel();
        check(gate.request(UpdatePolicy.CheckReason.OPEN, permission.isWaiting(), 1000, 999), "released permission ownership permits next opening check"); gate.finished();
        permission.begin();
        check(!permission.releaseIfOwnerGone(true, false, false), "living permission owner retains request across ordinary background activity");
        check(!permission.releaseIfOwnerGone(true, true, true), "configuration recreation retains permission result ownership for replacement activity");
        check(permission.releaseIfOwnerGone(true, true, false) && !permission.isWaiting(), "finished original activity cannot leave permission wait blocking future openings");
        permission.begin();
        check(permission.releaseIfOwnerGone(false, false, false), "garbage-collected permission owner also releases orphan protection");

        check(UpdatePolicy.recoverInstallation(10304, 10304, false, false, false) == UpdatePolicy.InstallRecovery.COMPLETE, "installed target completes recovery even if system removed its session");
        check(UpdatePolicy.recoverInstallation(10305, 10304, true, true, true) == UpdatePolicy.InstallRecovery.COMPLETE, "installation newer than target is complete, never offered a downgrade");
        check(UpdatePolicy.recoverInstallation(10304, 10305, true, true, false) == UpdatePolicy.InstallRecovery.WAIT, "active writer or optimizer is retained without abandonment");
        check(UpdatePolicy.recoverInstallation(10304, 10305, true, false, true) == UpdatePolicy.InstallRecovery.WAIT, "sealed inactive session awaiting user confirmation is retained");
        check(UpdatePolicy.recoverInstallation(10304, 10305, true, true, true) == UpdatePolicy.InstallRecovery.WAIT, "active committed installation keeps check/install protection");
        check(UpdatePolicy.recoverInstallation(10304, 10305, true, false, false) == UpdatePolicy.InstallRecovery.RETRY, "abandoned uncommitted inactive writer can be discarded and retried explicitly");
        check(UpdatePolicy.recoverInstallation(10304, 10305, false, false, false) == UpdatePolicy.InstallRecovery.RETRY, "missing ended session releases protection and retains verified APK for retry");
        check(UpdatePolicy.recoverInstallation(10304, 0, true, false, true) == UpdatePolicy.InstallRecovery.WAIT, "missing target metadata does not justify abandoning a sealed system session");
        check(UpdatePolicy.recoverInstallation(10304, 0, false, false, false) == UpdatePolicy.InstallRecovery.RETRY, "missing session and target metadata cannot report installation success");

        UpdatePolicy.OpenLifecycle main = new UpdatePolicy.OpenLifecycle(), scanner = new UpdatePolicy.OpenLifecycle(false);
        check(main.onStart() && !scanner.onStart(), "starting scanner while main is still visible adds no opening check");
        main.onStop(true); scanner.onStop(false);
        check(scanner.onStart(), "Home then task reopen on scanner creates one opening even while main stays stopped");
        main.openedElsewhere();
        check(!main.onStart(), "return from reopened scanner does not check again in main");
        scanner.onStop(true);
        check(!scanner.onStart(), "scanner permission or configuration return does not create an opening");
        UpdatePolicy.OpenLifecycle restoredMain = new UpdatePolicy.OpenLifecycle(); restoredMain.openedElsewhere();
        check(!restoredMain.onStart(), "cold-start restored scanner consumes initial opening before later main restoration");
    }
    public static void main(String[] args) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); keys = generator.generateKeyPair();
        check(UpdatePolicy.publicKey(keys.getPublic().getEncoded()).equals(keys.getPublic()), "DER public key loads");
        UpdatePolicy.Release release = verify(manifest()); check(release.versionCode == 10100 && release.version.equals("1.1.0"), "valid signed upgrade accepted");
        check(UpdatePolicy.verify(envelope(manifest()), keys.getPublic(), 10100, 35) == null, "same version never offered");
        check(UpdatePolicy.verify(envelope(manifest()), keys.getPublic(), 10200, 35) == null, "downgrade never offered");
        JSONObject tampered = new JSONObject(new String(envelope(manifest()), StandardCharsets.UTF_8)); JSONObject altered = manifest(); altered.getJSONObject("android").put("versionCode", 10200); tampered.put("payload", Base64.getEncoder().encodeToString(altered.toString().getBytes(StandardCharsets.UTF_8)));
        rejects(() -> UpdatePolicy.verify(tampered.toString().getBytes(StandardCharsets.UTF_8), keys.getPublic(), 10000, 35), "tampered payload rejected");
        KeyPair other = generator.generateKeyPair(); rejects(() -> UpdatePolicy.verify(envelope(manifest()), other.getPublic(), 10000, 35), "wrong signing key rejected");
        JSONObject wrongRepo = manifest().put("repository", "someone/other"); rejects(() -> verify(wrongRepo), "wrong repository rejected");
        JSONObject wrongPackage = manifest(); wrongPackage.getJSONObject("android").put("packageName", "com.attacker.app"); rejects(() -> verify(wrongPackage), "wrong package rejected");
        JSONObject tooNewSdk = manifest(); tooNewSdk.getJSONObject("android").put("minSdk", 36); rejects(() -> verify(tooNewSdk), "incompatible SDK rejected");
        JSONObject badCode = manifest(); badCode.getJSONObject("android").put("versionCode", "10100"); rejects(() -> verify(badCode), "string versionCode rejected");
        JSONObject huge = manifest(); huge.getJSONObject("android").put("size", UpdatePolicy.MAX_APK_BYTES + 1); rejects(() -> verify(huge), "oversized artifact rejected");
        JSONObject badDigest = manifest(); badDigest.getJSONObject("android").put("sha256", "bad"); rejects(() -> verify(badDigest), "invalid digest rejected");
        JSONObject wrongSchema = manifest().put("schema", 2); rejects(() -> verify(wrongSchema), "unknown schema rejected");
        String root = "https://github.com/" + UpdatePolicy.REPOSITORY + "/releases/download/v1.6.0/";
        check(UpdatePolicy.validateDownloadUrl(root + "SuperLedger-Mobile-1.1.0.apk", true).getHost().equals("github.com"), "canonical release URL accepted");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root.replace("https:", "http:") + "a.apk", true), "HTTP rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root.replace("github.com", "github.com.evil.test") + "a.apk", true), "lookalike hostname rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root.replace(UpdatePolicy.REPOSITORY, "someone/other") + "a.apk", true), "other repository URL rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root.replace("https://", "https://user@") + "a.apk", true), "userinfo URL rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root + "%2e%2e/a.apk", true), "encoded traversal rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root + "a.exe", true), "non APK artifact rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root + "a.apk?redirect=evil", true), "unexpected initial query rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl(root + "a.apk#fragment", true), "fragment rejected");
        check(UpdatePolicy.validateDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/123?token=test", false).getHost().equals("release-assets.githubusercontent.com"), "GitHub release asset redirect accepted");
        check(UpdatePolicy.validateDownloadUrl("https://objects.githubusercontent.com/asset/test", false).getHost().equals("objects.githubusercontent.com"), "GitHub objects redirect accepted");
        rejects(() -> UpdatePolicy.validateDownloadUrl("https://release-assets.githubusercontent.com/asset", true), "initial URL must identify exact repository");
        rejects(() -> UpdatePolicy.validateDownloadUrl("https://raw.githubusercontent.com/evil/repo/apk", false), "unlisted redirect host rejected");
        rejects(() -> UpdatePolicy.validateDownloadUrl("http://objects.githubusercontent.com/asset", false), "redirect cannot downgrade TLS");
        File apk = File.createTempFile("superledger-update-policy-", ".apk"); Files.write(apk.toPath(), CONTENT); UpdatePolicy.verifyFile(apk, release); check(true, "matching file digest and size accepted");
        byte[] changed = CONTENT.clone(); changed[0] ^= 1; Files.write(apk.toPath(), changed); rejects(() -> UpdatePolicy.verifyFile(apk, release), "same-size corrupted file rejected");
        Files.write(apk.toPath(), new byte[]{1, 2, 3}); rejects(() -> UpdatePolicy.verifyFile(apk, release), "truncated file rejected"); Files.delete(apk.toPath());
        UpdatePolicy.verifyIdentity(release, UpdatePolicy.PACKAGE_NAME, "1.1.0", 10100, 26, CERTIFICATE, CERTIFICATE, 10000, 35); check(true, "same-package same-signature upgrade identity accepted");
        rejects(() -> UpdatePolicy.verifyIdentity(release, "com.other", "1.1.0", 10100, 26, CERTIFICATE, CERTIFICATE, 10000, 35), "archive package mismatch rejected");
        rejects(() -> UpdatePolicy.verifyIdentity(release, UpdatePolicy.PACKAGE_NAME, "1.1.0", 10100, 26, CERTIFICATE, CERTIFICATE, 10100, 35), "archive cannot reinstall same version");
        rejects(() -> UpdatePolicy.verifyIdentity(release, UpdatePolicy.PACKAGE_NAME, "1.1.0", 10100, 26, CERTIFICATE, "different", 10000, 35), "archive must match installed signer");
        rejects(() -> UpdatePolicy.verifyIdentity(release, UpdatePolicy.PACKAGE_NAME, "1.2.0", 10100, 26, CERTIFICATE, CERTIFICATE, 10000, 35), "archive versionName must match signed manifest");
        rejects(() -> UpdatePolicy.verifyIdentity(release, UpdatePolicy.PACKAGE_NAME, "1.1.0", 10100, 27, CERTIFICATE, CERTIFICATE, 10000, 35), "archive minimum SDK must match manifest");
        long now = 1000000000L; check(!UpdatePolicy.shouldCheck(now, now - 1000, false), "automatic checks limited within six hours");
        check(UpdatePolicy.shouldCheck(now, now - 6L * 60 * 60 * 1000, false), "six-hour check permitted");
        check(UpdatePolicy.shouldCheck(now, now - 1000, true), "manual check bypasses interval");
        check(UpdatePolicy.shouldCheck(now, now + 10000, false), "clock rollback does not disable future checking");
        check(UpdatePolicy.readVerifiedRelease(envelope(manifest()), keys.getPublic()).versionCode == 10100, "verified older release remains inspectable before installed-version filtering");
        check(release.sources.size() == 3 && release.sources.get(0).id.equals("gh-proxy"), "old signed metadata receives registered fallback routes");
        check(UpdateSources.downloadEndpoints(release, "github").size() == 1 && UpdateSources.downloadEndpoints(release, "github").get(0).url.equals(release.url), "manual GitHub selection uses canonical URL");
        rejects(() -> release.sources.clear(), "source list cannot be changed after verification");
        org.json.JSONArray declared = new org.json.JSONArray();
        for (UpdateSources.Endpoint endpoint : release.sources) declared.put(new JSONObject().put("id", endpoint.id).put("url", endpoint.url));
        JSONObject multi = manifest(); multi.getJSONObject("android").put("sources", declared);
        check(verify(multi).sources.size() == 3, "signed registered source list accepted");
        JSONObject badSources = manifest(); badSources.getJSONObject("android").put("sources", "https://untrusted.invalid");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> verify(badSources), "invalid source list is a non-retryable integrity failure");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.readVerifiedRelease(tampered.toString().getBytes(StandardCharsets.UTF_8), keys.getPublic()), "bad signature is typed as integrity, never stale or transport failure");
        UpdatePolicy.validateVersionFence(release, 10000, 10100, release.sha256, release.size); check(true, "matching version and immutable artifact accepted");
        UpdatePolicy.validateVersionFence(release, 10100, 0, "", 0); check(true, "same installed version remains valid for latest-version suppression");
        UpdatePolicy.validateVersionFence(release, 10000, 10000, "", 0); check(true, "newer authenticated release accepted without old fingerprint");
        UpdatePolicy.validateVersionFence(release, 10304, 0, "", 0); check(true, "local build ahead of public release is not a remote rollback");
        UpdatePolicy.validateVersionFence(release, 10304, 10100, release.sha256, release.size); check(true, "local newer build accepts unchanged highest verified public release");
        rejectsAs(UpdatePolicy.StaleReleaseException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10200, release.sha256, release.size), "older than highest verified release is stale even before installation");
        rejectsAs(UpdatePolicy.StaleReleaseException.class, () -> UpdatePolicy.validateVersionFence(release, 10304, 10200, release.sha256, release.size), "local build ahead does not disable verified remote rollback protection");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, "0000000000000000000000000000000000000000000000000000000000000000", release.size), "same version with different hash is not a retryable old mirror");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, release.sha256, release.size + 1), "same version with different size is rejected");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, "", release.size), "inconsistent saved fingerprint is rejected");
        openingChecks();
        recoveryChecks();
        System.out.println("UpdatePolicy: " + checks + " offline checks passed (no network, no installer)");
    }
}
