package com.moneylab.superledger.mobile;

import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;

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
        rejectsAs(UpdatePolicy.StaleReleaseException.class, () -> UpdatePolicy.validateVersionFence(release, 10200, 0, "", 0), "older than installation is a retryable stale mirror");
        rejectsAs(UpdatePolicy.StaleReleaseException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10200, release.sha256, release.size), "older than highest verified release is stale even before installation");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, "0000000000000000000000000000000000000000000000000000000000000000", release.size), "same version with different hash is not a retryable old mirror");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, release.sha256, release.size + 1), "same version with different size is rejected");
        rejectsAs(UpdatePolicy.IntegrityException.class, () -> UpdatePolicy.validateVersionFence(release, 10000, 10100, "", release.size), "inconsistent saved fingerprint is rejected");
        System.out.println("UpdatePolicy: " + checks + " offline checks passed (no network, no installer)");
    }
}
