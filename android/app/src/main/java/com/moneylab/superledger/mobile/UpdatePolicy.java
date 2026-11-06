package com.moneylab.superledger.mobile;

import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Locale;
import java.util.List;

/** Pure Java policy shared by Android runtime and offline host regression tests. */
public final class UpdatePolicy {
    public static final String REPOSITORY = "moshangqingchen/super-ledger";
    public static final String PACKAGE_NAME = "com.moneylab.superledger.mobile";
    public static final String MANIFEST_URL = "https://raw.githubusercontent.com/" + REPOSITORY + "/main/updates/stable.json";
    public static final int MAX_MANIFEST_BYTES = 128 * 1024;
    public static final long MAX_APK_BYTES = 128L * 1024 * 1024;
    private UpdatePolicy() {}
    public static final class IntegrityException extends Exception {
        public IntegrityException(String message) { super(message); }
        public IntegrityException(String message, Throwable cause) { super(message, cause); }
    }
    public static final class StaleReleaseException extends Exception {
        public StaleReleaseException() { super("此更新源的版本较旧，正在尝试其他来源"); }
    }
    public static boolean shouldCheck(long now, long lastCheck, boolean manual) { return manual || lastCheck <= 0 || now < lastCheck || now - lastCheck >= 6L * 60 * 60 * 1000; }
    public enum CheckReason { PERIODIC, OPEN, MANUAL }
    /** One check per actual opening; focus/resume and temporary child activities are not openings. */
    public static final class OpenLifecycle {
        private boolean started, pendingOpen;
        public OpenLifecycle() { this(true); }
        public OpenLifecycle(boolean initialOpen) { pendingOpen = initialOpen; }
        public synchronized boolean onStart() {
            if (started) return false;
            started = true; boolean result = pendingOpen; pendingOpen = false; return result;
        }
        public synchronized void onStop(boolean temporary) {
            if (!started) return;
            started = false; pendingOpen = !temporary;
        }
        /** Call only for an explicit launcher intent, not arbitrary activity results. */
        public synchronized boolean onLauncherIntent() {
            if (started) return true;
            pendingOpen = true; return false;
        }
        public synchronized void openedElsewhere() { pendingOpen = false; }
    }
    /** Initialization queues one request; concurrent requests share the active check. */
    public static final class CheckGate {
        private boolean restoring = true, checking;
        private CheckReason pending;
        public synchronized boolean request(CheckReason reason, boolean operationInProgress, long now, long lastCheck) {
            if (reason == null) throw new IllegalArgumentException("Missing update check reason");
            if (restoring) {
                if (pending == null || reason != CheckReason.PERIODIC) pending = reason;
                return false;
            }
            if (checking || operationInProgress || !shouldCheck(now, lastCheck, reason != CheckReason.PERIODIC)) return false;
            checking = true; return true;
        }
        public synchronized CheckReason restored() {
            restoring = false; CheckReason result = pending; pending = null; return result;
        }
        public synchronized void finished() { checking = false; }
    }
    /** Permission-result ownership lasts only as long as this process. */
    public static final class InstallPermission {
        private boolean waiting;
        public synchronized boolean begin() { if (waiting) return false; waiting = true; return true; }
        public synchronized boolean isWaiting() { return waiting; }
        public synchronized boolean returned() { boolean result = waiting; waiting = false; return result; }
        public synchronized void cancel() { waiting = false; }
        public synchronized boolean releaseIfOwnerGone(boolean ownerExists, boolean destroyed, boolean changingConfigurations) {
            if (!waiting || ownerExists && (!destroyed || changingConfigurations)) return false;
            waiting = false; return true;
        }
    }
    public enum InstallRecovery { NONE, COMPLETE, WAIT, RETRY }
    /** A sealed session can be waiting for user action even when it is not active. */
    public static InstallRecovery recoverInstallation(long installedCode, long targetCode, boolean sessionPresent, boolean active, boolean sealed) {
        if (targetCode > 0 && installedCode >= targetCode) return InstallRecovery.COMPLETE;
        if (sessionPresent && (active || sealed)) return InstallRecovery.WAIT;
        return InstallRecovery.RETRY;
    }
    public static final class Release {
        public final String version, url, sha256, notes, packageName, certificateSha256;
        public final long versionCode, size;
        public final int minSdk;
        public final List<UpdateSources.Endpoint> sources;
        private Release(JSONObject android) throws Exception {
            version = requiredString(android, "version", 80);
            if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?")) throw new Exception("更新版本号格式无效");
            versionCode = strictInteger(android, "versionCode", 1, Integer.MAX_VALUE);
            url = requiredString(android, "url", 4096); validateDownloadUrl(url, true);
            if (android.has("sources") && !(android.opt("sources") instanceof org.json.JSONArray)) throw new IntegrityException("更新源列表格式无效");
            sources = UpdateSources.parseSources(url, android.optJSONArray("sources"));
            sha256 = requiredHash(android, "sha256"); certificateSha256 = requiredHash(android, "certificateSha256");
            packageName = requiredString(android, "packageName", 180); if (!PACKAGE_NAME.equals(packageName)) throw new Exception("更新包不属于超级账本手机版");
            size = strictInteger(android, "size", 1, MAX_APK_BYTES);
            minSdk = (int) strictInteger(android, "minSdk", 26, 1000);
            notes = android.has("notes") ? requiredString(android, "notes", 12000) : "本次更新包含功能改进与问题修复。";
        }
    }
    private static String requiredString(JSONObject object, String key, int max) throws Exception {
        Object value = object.opt(key);
        if (!(value instanceof String) || ((String) value).trim().isEmpty() || ((String) value).length() > max || ((String) value).indexOf('\u0000') >= 0) throw new Exception("更新清单字段无效：" + key);
        return (String) value;
    }
    private static long strictInteger(JSONObject object, String key, long min, long max) throws Exception {
        Object value = object.opt(key);
        if (!(value instanceof Number) || value instanceof Double || value instanceof Float) throw new Exception("更新清单数字字段无效：" + key);
        long result = ((Number) value).longValue(); if (result < min || result > max) throw new Exception("更新清单数字超出范围：" + key); return result;
    }
    private static String requiredHash(JSONObject object, String key) throws Exception { String value = requiredString(object, key, 64); if (!value.matches("[a-fA-F0-9]{64}")) throw new Exception("更新校验值无效：" + key); return value.toLowerCase(Locale.US); }
    private static String utf8(byte[] bytes) throws Exception { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
    public static PublicKey publicKey(byte[] der) throws Exception {
        if (der == null || der.length < 200 || der.length > 8192) throw new Exception("应用更新公钥无效");
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        if (!(key instanceof RSAPublicKey) || ((RSAPublicKey) key).getModulus().bitLength() < 2048) throw new Exception("应用更新公钥强度无效"); return key;
    }
    /** Parse all authenticated releases, including older ones, before applying a persisted version fence. */
    public static Release readVerifiedRelease(byte[] envelopeBytes, PublicKey key) throws Exception {
        try { return parseVerifiedRelease(envelopeBytes, key); }
        catch (IntegrityException error) { throw error; }
        catch (Exception error) { throw new IntegrityException(error.getMessage() == null ? "更新清单验证失败" : error.getMessage(), error); }
    }
    private static Release parseVerifiedRelease(byte[] envelopeBytes, PublicKey key) throws Exception {
        if (envelopeBytes == null || envelopeBytes.length == 0 || envelopeBytes.length > MAX_MANIFEST_BYTES) throw new Exception("更新清单过大或为空");
        JSONObject envelope = new JSONObject(utf8(envelopeBytes));
        if (strictInteger(envelope, "schema", 1, 1) != 1) throw new Exception("更新清单版本不兼容");
        String encodedPayload = requiredString(envelope, "payload", MAX_MANIFEST_BYTES), encodedSignature = requiredString(envelope, "signature", 4096);
        byte[] payload, signature;
        try { payload = Base64.getDecoder().decode(encodedPayload); signature = Base64.getDecoder().decode(encodedSignature); }
        catch (IllegalArgumentException error) { throw new Exception("更新清单签名编码无效"); }
        if (payload.length == 0 || payload.length > 64 * 1024) throw new Exception("更新清单内容过大或为空");
        Signature verifier = Signature.getInstance("SHA256withRSA"); verifier.initVerify(key); verifier.update(payload);
        if (!verifier.verify(signature)) throw new Exception("更新清单签名不匹配，已停止更新");
        JSONObject manifest = new JSONObject(utf8(payload)); strictInteger(manifest, "schema", 1, 1);
        if (!REPOSITORY.equals(requiredString(manifest, "repository", 180))) throw new Exception("更新清单来自其他仓库");
        String publishedAt = requiredString(manifest, "publishedAt", 80);
        if (!publishedAt.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z")) throw new Exception("更新时间格式无效");
        JSONObject android = manifest.optJSONObject("android"); if (android == null) throw new Exception("更新清单缺少手机版信息");
        return new Release(android);
    }
    /** Returns null for a correctly signed release that is not newer than this installation. */
    public static Release verify(byte[] envelopeBytes, PublicKey key, long installedVersionCode, int deviceSdk) throws Exception {
        Release release = readVerifiedRelease(envelopeBytes, key);
        if (release.versionCode <= installedVersionCode) return null;
        if (release.minSdk > deviceSdk) throw new Exception("新版需要更高的安卓系统，当前版本仍可正常使用");
        return release;
    }
    /** Only a stale signed mirror can be retried; a changed artifact at the same version is an integrity error. */
    public static void validateVersionFence(Release release, long installedCode, long highestCode, String highestSha256, long highestSize) throws Exception {
        if (release == null || installedCode < 0 || highestCode < 0 || highestSize < 0 || ((highestSha256 == null || highestSha256.isEmpty()) && highestSize != 0)) throw new IntegrityException("已保存的版本校验状态无效");
        // A locally installed build may be ahead of the public channel. Only
        // authenticated remote history establishes the anti-rollback fence;
        // verify()/verifyIdentity() independently prevent downgrade installation.
        if (release.versionCode < highestCode) throw new StaleReleaseException();
        if (release.versionCode == highestCode && highestSha256 != null && !highestSha256.isEmpty()) {
            if (!highestSha256.matches("[a-fA-F0-9]{64}") || highestSize < 1 || !release.sha256.equalsIgnoreCase(highestSha256) || release.size != highestSize) throw new IntegrityException("同一版本的安装包校验值发生变化，已停止更新");
        }
    }
    public static URI validateDownloadUrl(String value, boolean initial) throws Exception {
        if (value == null || value.length() > 12000 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) throw new Exception("更新下载地址无效");
        URI uri = new URI(value); String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
        if (!"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new Exception("更新下载只允许标准 HTTPS 地址");
        boolean github = host.equals("github.com"), asset = host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com");
        if (!github && (!asset || initial)) throw new Exception("更新下载跳转到未授权主机，已停止");
        if (github) {
            String path = uri.getRawPath(); String prefix = "/" + REPOSITORY + "/releases/download/";
            if (path == null || !path.startsWith(prefix) || uri.getRawQuery() != null) throw new Exception("更新下载不属于指定仓库的正式发布");
            String suffix = path.substring(prefix.length());
            if (!suffix.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}/[A-Za-z0-9][A-Za-z0-9._-]{0,149}\\.apk")) throw new Exception("更新包路径格式无效");
        } else if (uri.getRawPath() == null || !uri.getRawPath().startsWith("/") || uri.getRawPath().contains("\\")) throw new Exception("更新资源路径无效");
        return uri;
    }
    public static String sha256(byte[] value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value)); }
    public static String hex(byte[] bytes) { StringBuilder builder = new StringBuilder(); for (byte value : bytes) builder.append(String.format(Locale.US, "%02x", value)); return builder.toString(); }
    public static void verifyFile(File file, Release release) throws Exception {
        if (file == null || !file.isFile() || file.length() != release.size) throw new Exception("安装包大小不匹配，请重新下载");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) { byte[] bytes = new byte[65536]; int count; long total = 0; while ((count = input.read(bytes)) >= 0) { total += count; if (total > release.size) throw new Exception("安装包在校验时发生变化"); digest.update(bytes, 0, count); } if (total != release.size) throw new Exception("安装包读取不完整"); }
        if (!hex(digest.digest()).equals(release.sha256)) throw new Exception("安装包 SHA-256 不匹配，已停止安装");
    }
    /** Android obtains these values from PackageManager, never from the filename. */
    public static void verifyIdentity(Release release, String archivePackage, String archiveVersion, long archiveCode, int archiveMinSdk, String archiveCertificate, String installedCertificate, long installedCode, int deviceSdk) throws Exception {
        if (!PACKAGE_NAME.equals(archivePackage) || !release.packageName.equals(archivePackage)) throw new Exception("安装包包名不匹配");
        if (!release.version.equals(archiveVersion) || release.versionCode != archiveCode || archiveCode <= installedCode) throw new Exception("安装包版本不匹配或不高于当前版本");
        if (archiveMinSdk != release.minSdk || archiveMinSdk > deviceSdk) throw new Exception("安装包与当前安卓系统不兼容");
        if (archiveCertificate == null || installedCertificate == null || !archiveCertificate.equalsIgnoreCase(installedCertificate) || !archiveCertificate.equalsIgnoreCase(release.certificateSha256)) throw new Exception("安装包签名不是当前应用的原签名，已停止安装");
    }
}
