package com.moneylab.superledger.mobile;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Public-release updater. It never opens, reads, or uploads the user's ledger. */
public final class AppUpdater {
    public static final int INSTALL_PERMISSION_REQUEST = 71, INSTALL_CONFIRM_REQUEST = 72;
    public static final String INSTALL_RESULT = "com.moneylab.superledger.mobile.UPDATE_INSTALL_RESULT";
    private static AppUpdater instance;
    public interface Listener { void onUpdaterChanged(); }
    public static final class Snapshot {
        public String phase, message, version;
        public long size, downloaded, checkedAt;
        public boolean busy, canDownload, canInstall;
    }
    private final Context context;
    private final SharedPreferences preferences;
    private final File directory;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WeakReference<Listener> listener = new WeakReference<>(null);
    private UpdatePolicy.Release candidate;
    private byte[] candidateEnvelope;
    private File readyFile;
    private boolean busy = true, offerPending, installRequested;
    private volatile boolean cancelDownload;
    private String phase = "checking", message = "正在读取更新状态…";
    private long downloaded;
    private Intent pendingConfirmation;
    public static synchronized AppUpdater get(Context context) {
        if (instance == null) instance = new AppUpdater(context.getApplicationContext()); return instance;
    }
    private AppUpdater(Context context) {
        this.context = context; preferences = context.getSharedPreferences("app-updates", Context.MODE_PRIVATE);
        directory = new File(context.getFilesDir(), "updates");
        worker.execute(() -> {
            try { restoreDownloaded(); }
            catch (Exception error) { synchronized (this) { phase = "idle"; message = "可手动检查新版，当前账本不受影响。"; } }
            finally { synchronized (this) { busy = false; } notifyChanged(); }
            check(false);
        });
    }
    public synchronized void attach(Listener next) { listener = new WeakReference<>(next); notifyChanged(); }
    public synchronized void detach(Listener previous) { if (listener.get() == previous) listener.clear(); }
    private void notifyChanged() { main.post(() -> { Listener target; synchronized (this) { target = listener.get(); } if (target != null) target.onUpdaterChanged(); }); }
    public synchronized Snapshot snapshot() {
        Snapshot state = new Snapshot(); state.phase = phase; state.message = message; state.version = candidate == null ? "" : candidate.version; state.size = candidate == null ? 0 : candidate.size;
        state.downloaded = downloaded; state.busy = busy || phase.equals("installing"); state.canDownload = !state.busy && candidate != null && readyFile == null; state.canInstall = !state.busy && candidate != null && readyFile != null;
        state.checkedAt = preferences.getLong("lastCheckAt", 0); return state;
    }
    public synchronized UpdatePolicy.Release consumeOffer() { if (!offerPending || busy || candidate == null) return null; offerPending = false; return candidate; }
    public synchronized boolean consumeInstallRequest() { if (!installRequested || busy || readyFile == null) return false; installRequested = false; return true; }
    public synchronized Intent consumeConfirmation() { Intent result = pendingConfirmation; pendingConfirmation = null; return result; }
    private PublicKey publicKey() throws Exception { try (InputStream input = context.getResources().openRawResource(R.raw.update_public_key)) { return UpdatePolicy.publicKey(readLimited(input, 8192)); } }
    @SuppressWarnings("deprecation") private PackageInfo installedInfo() throws Exception { return context.getPackageManager().getPackageInfo(context.getPackageName(), Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES); }
    @SuppressWarnings("deprecation") private static long versionCode(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private long installedVersionCode() throws Exception { return versionCode(installedInfo()); }
    private static byte[] readLimited(InputStream input, int max) throws Exception {
        ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) >= 0) { if (result.size() + count > max) throw new Exception("更新响应超过允许大小"); result.write(buffer, 0, count); } return result.toByteArray();
    }
    private void ensureDirectory() throws Exception { if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建更新缓存，请检查存储空间"); }
    private File artifactFile(UpdatePolicy.Release release) { return new File(directory, "mobile-" + release.versionCode + "-" + release.sha256.substring(0, 16) + ".apk"); }
    private AtomicFile metadataFile() { return new AtomicFile(new File(directory, "signed-release.json")); }
    private void saveMetadata(byte[] bytes) throws Exception {
        ensureDirectory(); AtomicFile file = metadataFile(); FileOutputStream output = null;
        try { output = file.startWrite(); output.write(bytes); file.finishWrite(output); }
        catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
    }
    private void restoreDownloaded() throws Exception {
        AtomicFile metadata = metadataFile(); File base = metadata.getBaseFile();
        if (!base.exists() && !new File(base.getPath() + ".bak").exists()) { synchronized (this) { phase = "idle"; message = "将在启动时定期检查公开版本。"; } return; }
        byte[] bytes; try (InputStream input = metadata.openRead()) { bytes = readLimited(input, UpdatePolicy.MAX_MANIFEST_BYTES); }
        UpdatePolicy.Release release = UpdatePolicy.verify(bytes, publicKey(), installedVersionCode(), Build.VERSION.SDK_INT);
        if (release == null) { clearActiveSession(); synchronized (this) { candidate = null; candidateEnvelope = null; readyFile = null; phase = "idle"; message = "当前版本已安装，账本保留在本机。"; } return; }
        if (!release.certificateSha256.equals(certificate(installedInfo()))) throw new Exception("更新清单的签名身份与当前应用不一致");
        File apk = artifactFile(release); boolean ready = false;
        if (apk.isFile()) { try { verifyApk(apk, release); ready = true; } catch (Exception ignored) { /* Never install a stale or altered cached APK. */ } }
        synchronized (this) { candidate = release; candidateEnvelope = bytes; readyFile = ready ? apk : null; phase = ready ? "ready" : "available"; message = ready ? "安装包已校验，可继续覆盖更新。" : "发现新版 " + release.version + "，可选择下载更新。"; }
    }
    public void check(boolean manual) {
        synchronized (this) {
            if (busy || phase.equals("installing")) return;
            long now = System.currentTimeMillis(), last = preferences.getLong("lastCheckAt", 0);
            if (!UpdatePolicy.shouldCheck(now, last, manual)) return;
            preferences.edit().putLong("lastCheckAt", now).apply(); busy = true; phase = "checking"; message = "正在检查 GitHub 上的公开版本…"; downloaded = 0;
        }
        notifyChanged();
        worker.execute(() -> {
            try {
                byte[] bytes = fetchManifest(); UpdatePolicy.Release release = UpdatePolicy.verify(bytes, publicKey(), installedVersionCode(), Build.VERSION.SDK_INT);
                if (release == null) {
                    synchronized (this) { candidate = null; candidateEnvelope = null; readyFile = null; offerPending = false; phase = "idle"; message = "当前已是最新版本。"; }
                } else {
                    if (!release.certificateSha256.equals(certificate(installedInfo()))) throw new Exception("更新清单的签名身份与当前应用不一致");
                    File apk = artifactFile(release); boolean ready = false;
                    if (apk.isFile()) { try { verifyApk(apk, release); ready = true; } catch (Exception ignored) {} }
                    saveMetadata(bytes);
                    synchronized (this) { candidate = release; candidateEnvelope = bytes; readyFile = ready ? apk : null; offerPending = true; phase = ready ? "ready" : "available"; message = "发现新版 " + release.version + (ready ? "，安装包已准备好。" : "，可选择下载更新。"); }
                }
            } catch (Exception error) { synchronized (this) { phase = readyFile != null ? "ready" : candidate != null ? "available" : "idle"; message = "检查更新未完成：" + safeMessage(error) + "。当前版本与账本不受影响，可稍后重试。"; } }
            finally { synchronized (this) { busy = false; } notifyChanged(); }
        });
    }
    private static String safeMessage(Exception error) { String value = error.getMessage(); if (value == null || value.length() > 240) return "网络或版本验证失败"; return value; }
    private static HttpsURLConnection connection(String url) throws Exception {
        // Uses Android's normal HTTPS / system proxy configuration. Never bypass an external proxy.
        HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity"); connection.setRequestProperty("User-Agent", "SuperLedger-Mobile-Updater"); return connection;
    }
    private byte[] fetchManifest() throws Exception {
        HttpsURLConnection connection = connection(UpdatePolicy.MANIFEST_URL);
        try {
            connection.setRequestProperty("Accept", "application/json"); int status = connection.getResponseCode();
            if (status != 200) throw new Exception(status == 404 ? "公开更新清单暂未发布" : "版本服务返回状态 " + status);
            if (connection.getContentLengthLong() > UpdatePolicy.MAX_MANIFEST_BYTES) throw new Exception("版本清单超过允许大小");
            try (InputStream input = connection.getInputStream()) { return readLimited(input, UpdatePolicy.MAX_MANIFEST_BYTES); }
        } finally { connection.disconnect(); }
    }
    public void download() {
        final UpdatePolicy.Release release; final byte[] envelope;
        synchronized (this) {
            if (busy || candidate == null) return;
            if (readyFile != null) { installRequested = true; notifyChanged(); return; }
            release = candidate; envelope = candidateEnvelope.clone(); busy = true; cancelDownload = false; phase = "downloading"; message = "正在下载并校验安装包…"; downloaded = 0; offerPending = false;
        }
        notifyChanged();
        worker.execute(() -> {
            File partial = null;
            try {
                ensureDirectory(); if (directory.getUsableSpace() > 0 && directory.getUsableSpace() < release.size * 2 + 1024 * 1024) throw new Exception("存储空间不足，请留出安装包大小两倍以上的空间");
                partial = new File(directory, "download-" + release.versionCode + ".part.apk"); downloadFile(release, partial); if (cancelDownload) throw new Exception("下载已取消");
                verifyApk(partial, release); if (cancelDownload) throw new Exception("下载已取消");
                File target = artifactFile(release); if (target.exists() && !target.delete()) throw new Exception("无法替换旧的更新缓存");
                if (!partial.renameTo(target)) throw new Exception("无法保存更新安装包"); partial = null; saveMetadata(envelope);
                synchronized (this) { readyFile = target; phase = "ready"; message = "下载与校验完成，等待系统确认覆盖更新。"; installRequested = true; }
            } catch (Exception error) { synchronized (this) { phase = "available"; message = safeMessage(error) + "。已有应用和账本未改动，可重新下载。"; installRequested = false; } }
            finally { if (partial != null && partial.isFile()) partial.delete(); synchronized (this) { busy = false; } notifyChanged(); }
        });
    }
    public void cancelDownload() { cancelDownload = true; synchronized (this) { if (phase.equals("downloading")) message = "正在取消下载，已有账本不受影响…"; } notifyChanged(); }
    private void downloadFile(UpdatePolicy.Release release, File outputFile) throws Exception {
        String address = release.url; long startedAt = System.currentTimeMillis();
        for (int redirects = 0; redirects <= 5; redirects++) {
            UpdatePolicy.validateDownloadUrl(address, redirects == 0); if (cancelDownload) throw new Exception("下载已取消");
            HttpsURLConnection connection = connection(address);
            try {
                connection.setRequestProperty("Accept", "application/octet-stream"); int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location"); if (location == null || redirects == 5) throw new Exception("下载跳转次数或地址无效");
                    address = new URI(address).resolve(location).toString(); UpdatePolicy.validateDownloadUrl(address, false); continue;
                }
                if (status != 200) throw new Exception("下载服务返回状态 " + status);
                String encoding = connection.getContentEncoding(); if (encoding != null && !encoding.isEmpty() && !encoding.equalsIgnoreCase("identity")) throw new Exception("安装包传输编码不符合要求");
                long declared = connection.getContentLengthLong(); if (declared >= 0 && declared != release.size) throw new Exception("安装包大小与签名清单不一致");
                long total = 0, lastNotification = 0;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(outputFile, false)) {
                    byte[] bytes = new byte[65536]; int count;
                    while ((count = input.read(bytes)) >= 0) {
                        if (cancelDownload) throw new Exception("下载已取消"); if (System.currentTimeMillis() - startedAt > 10 * 60 * 1000L) throw new Exception("下载超时，请稍后重试");
                        total += count; if (total > release.size || total > UpdatePolicy.MAX_APK_BYTES) throw new Exception("安装包超过签名清单声明的大小"); output.write(bytes, 0, count);
                        if (System.currentTimeMillis() - lastNotification > 400) { lastNotification = System.currentTimeMillis(); synchronized (this) { downloaded = total; } notifyChanged(); }
                    }
                    output.flush(); output.getFD().sync();
                }
                if (total != release.size) throw new Exception("安装包下载不完整"); synchronized (this) { downloaded = total; } return;
            } finally { connection.disconnect(); }
        }
        throw new Exception("下载跳转过多");
    }
    @SuppressWarnings("deprecation") private static String certificate(PackageInfo info) throws Exception {
        Signature[] signers;
        if (Build.VERSION.SDK_INT >= 28) { if (info.signingInfo == null) throw new Exception("无法读取安装包签名"); signers = info.signingInfo.getApkContentsSigners(); }
        else signers = info.signatures;
        if (signers == null || signers.length != 1) throw new Exception("更新包签名数量不符合原应用要求"); return UpdatePolicy.sha256(signers[0].toByteArray());
    }
    private void verifyApk(File apk, UpdatePolicy.Release release) throws Exception {
        UpdatePolicy.verifyFile(apk, release); PackageManager manager = context.getPackageManager();
        @SuppressWarnings("deprecation") PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
        if (archive == null || archive.applicationInfo == null) throw new Exception("下载文件不是可解析的安卓安装包"); PackageInfo current = installedInfo();
        UpdatePolicy.verifyIdentity(release, archive.packageName, archive.versionName, versionCode(archive), archive.applicationInfo.minSdkVersion, certificate(archive), certificate(current), versionCode(current), Build.VERSION.SDK_INT);
    }
    public void requestInstall(Activity activity) throws Exception {
        synchronized (this) { if (busy || phase.equals("installing") || readyFile == null || candidate == null) throw new Exception("安装包尚未准备好，或系统正在处理上一次安装"); }
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            preferences.edit().putBoolean("awaitingInstallPermission", true).apply();
            synchronized (this) { message = "请允许超级账本安装更新，返回后会继续系统安装确认。"; }
            activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())), INSTALL_PERMISSION_REQUEST); notifyChanged(); return;
        }
        beginInstall();
    }
    public void permissionReturned() {
        if (!preferences.getBoolean("awaitingInstallPermission", false)) return;
        preferences.edit().putBoolean("awaitingInstallPermission", false).apply();
        if (context.getPackageManager().canRequestPackageInstalls()) beginInstall();
        else { synchronized (this) { phase = "ready"; message = "安装权限尚未开启。安装包已保留，可在需要时点「安装更新」重试。"; } notifyChanged(); }
    }
    private void beginInstall() {
        final UpdatePolicy.Release release; final File apk;
        synchronized (this) { if (busy || readyFile == null || candidate == null) return; release = candidate; apk = readyFile; busy = true; phase = "installing"; message = "正在准备覆盖安装，请在系统界面确认…"; installRequested = false; pendingConfirmation = null; }
        notifyChanged(); worker.execute(() -> {
            int sessionId = -1;
            try {
                verifyApk(apk, release);
                if (!context.getPackageManager().canRequestPackageInstalls()) throw new Exception("系统尚未允许本应用安装更新");
                PackageInstaller installer = context.getPackageManager().getPackageInstaller(); int old = preferences.getInt("activeSessionId", -1);
                if (old >= 0) { try { installer.abandonSession(old); } catch (Exception ignored) {} }
                PackageInstaller.SessionParams parameters = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                parameters.setAppPackageName(context.getPackageName()); parameters.setAppLabel("超级账本"); parameters.setSize(release.size); parameters.setInstallReason(PackageManager.INSTALL_REASON_USER);
                if (Build.VERSION.SDK_INT >= 31) parameters.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                sessionId = installer.createSession(parameters);
                preferences.edit().putInt("activeSessionId", sessionId).putLong("installVersionCode", release.versionCode).putLong("installStartedAt", System.currentTimeMillis()).apply();
                try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                    try (InputStream input = new FileInputStream(apk); OutputStream output = session.openWrite("base.apk", 0, release.size)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count); session.fsync(output); }
                    Intent result = new Intent(context, UpdateInstallReceiver.class).setAction(INSTALL_RESULT).setData(Uri.parse("superledger-update://result/" + sessionId));
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT; if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                    PendingIntent pending = PendingIntent.getBroadcast(context, sessionId, result, flags); session.commit(pending.getIntentSender());
                }
                synchronized (this) { message = "安装已交给安卓系统，等待你确认。若取消，可稍后再次安装。"; }
                checkInstallOutcomeLater();
            } catch (Exception error) {
                if (sessionId >= 0) { try { context.getPackageManager().getPackageInstaller().abandonSession(sessionId); } catch (Exception ignored) {} }
                clearActiveSession(); synchronized (this) { phase = "ready"; message = "安装未完成：" + safeMessage(error) + "。当前应用与账本保留。"; }
            } finally { synchronized (this) { busy = false; } notifyChanged(); }
        });
    }
    private void clearActiveSession() { preferences.edit().remove("activeSessionId").remove("installVersionCode").remove("installStartedAt").putBoolean("awaitingInstallPermission", false).apply(); }
    public void installerReturned() {
        synchronized (this) { if (phase.equals("installing")) message = "正在等待安卓系统返回安装结果，取消安装不会删除账本。"; }
        notifyChanged(); checkInstallOutcomeLater();
    }
    private void checkInstallOutcomeLater() {
        main.postDelayed(() -> worker.execute(() -> {
            int sessionId = preferences.getInt("activeSessionId", -1); if (sessionId < 0) return;
            try {
                long targetCode = preferences.getLong("installVersionCode", Long.MAX_VALUE);
                if (installedVersionCode() >= targetCode) {
                    clearActiveSession(); synchronized (this) { candidate = null; candidateEnvelope = null; readyFile = null; phase = "idle"; message = "新版已安装，账本保留在本机。"; } notifyChanged(); return;
                }
                PackageInstaller.SessionInfo info = context.getPackageManager().getPackageInstaller().getSessionInfo(sessionId);
                long elapsed = System.currentTimeMillis() - preferences.getLong("installStartedAt", 0);
                if (info == null || elapsed > 120000 || elapsed < 0) {
                    if (info == null) clearActiveSession();
                    synchronized (this) { phase = readyFile == null ? "available" : "ready"; message = "系统尚未完成更新。当前版本和账本保留，可点击「安装更新」重试。"; }
                    notifyChanged(); return;
                }
                checkInstallOutcomeLater();
            } catch (Exception error) { synchronized (this) { phase = readyFile == null ? "available" : "ready"; message = "无法确认系统安装结果，请查看当前版本，必要时再次安装。"; } notifyChanged(); }
        }), 3000);
    }
    public void handleInstallResult(Intent intent) {
        if (!INSTALL_RESULT.equals(intent.getAction()) || intent.getData() == null) return;
        int sessionId; try { sessionId = Integer.parseInt(intent.getData().getLastPathSegment()); } catch (Exception ignored) { return; }
        if (sessionId != preferences.getInt("activeSessionId", -1)) return;
        int callbackSession = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId); if (callbackSession != sessionId) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @SuppressWarnings("deprecation") Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            synchronized (this) { pendingConfirmation = confirmation; phase = confirmation == null ? "ready" : "installing"; message = confirmation == null ? "系统未提供安装确认界面，请重试。" : "请在安卓系统界面确认安装更新。"; }
        } else {
            clearActiveSession(); synchronized (this) {
                pendingConfirmation = null; installRequested = false;
                if (status == PackageInstaller.STATUS_SUCCESS) { candidate = null; candidateEnvelope = null; readyFile = null; phase = "idle"; message = "新版已安装，重新打开即可使用。账本保留在本机。"; }
                else { phase = readyFile == null ? "available" : "ready"; message = status == PackageInstaller.STATUS_FAILURE_ABORTED ? "已取消安装，当前版本与账本保留，可随时重试。" : status == PackageInstaller.STATUS_FAILURE_STORAGE ? "系统存储空间不足，安装包已保留，请清理空间后重试。" : "系统未完成安装（状态 " + status + "），当前版本与账本保留，可重试。"; }
            }
        }
        notifyChanged();
    }
}
