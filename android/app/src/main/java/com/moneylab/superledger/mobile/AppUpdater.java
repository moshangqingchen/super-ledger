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
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Public-release updater. It never opens, reads, or uploads the user's ledger. */
public final class AppUpdater {
    public static final int INSTALL_PERMISSION_REQUEST = 71, INSTALL_CONFIRM_REQUEST = 72;
    public static final String INSTALL_RESULT = "com.moneylab.superledger.mobile.UPDATE_INSTALL_RESULT";
    private static AppUpdater instance;
    public interface Listener { void onUpdaterChanged(); }
    public static final class Snapshot {
        public String phase, message, version, notes, sourceMode, sourceLabel;
        public long size, downloaded, checkedAt;
        public boolean busy, canDownload, canInstall;
    }
    private final Context context;
    private final SharedPreferences preferences;
    private final File directory;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final UpdatePolicy.OpenLifecycle openLifecycle = new UpdatePolicy.OpenLifecycle();
    private final UpdatePolicy.CheckGate checkGate = new UpdatePolicy.CheckGate();
    private final UpdatePolicy.InstallPermission installPermission = new UpdatePolicy.InstallPermission();
    private WeakReference<Activity> permissionOwner = new WeakReference<>(null);
    private boolean activityOpened;
    private final PackageInstaller.SessionCallback installCallback = new PackageInstaller.SessionCallback() {
        @Override public void onCreated(int sessionId) {}
        @Override public void onBadgingChanged(int sessionId) {}
        @Override public void onProgressChanged(int sessionId, float progress) {}
        @Override public void onActiveChanged(int sessionId, boolean active) {
            if (sessionId == preferences.getInt("activeSessionId", -1)) worker.execute(() -> { recoverInstallSession(); notifyChanged(); });
        }
        @Override public void onFinished(int sessionId, boolean success) {
            finishInstallSession(sessionId, success ? PackageInstaller.STATUS_SUCCESS : PackageInstaller.STATUS_FAILURE);
        }
    };
    private WeakReference<Listener> listener = new WeakReference<>(null);
    private UpdatePolicy.Release candidate;
    private byte[] candidateEnvelope;
    private File readyFile;
    private boolean busy = true, offerPending, installRequested;
    private volatile boolean cancelDownload;
    private UpdateSourceClient.Session activeSession;
    private String sourceLabel = "自动选择";
    private String phase = "checking", message = "正在读取更新状态…";
    private long downloaded;
    private Intent pendingConfirmation;
    public static synchronized AppUpdater get(Context context) {
        if (instance == null) instance = new AppUpdater(context.getApplicationContext()); return instance;
    }
    private AppUpdater(Context context) {
        this.context = context; preferences = context.getSharedPreferences("app-updates", Context.MODE_PRIVATE);
        directory = new File(context.getFilesDir(), "updates");
        // A previous process cannot own a future Activity permission result.
        preferences.edit().remove("awaitingInstallPermission").apply();
        context.getPackageManager().getPackageInstaller().registerSessionCallback(installCallback, main);
        worker.execute(() -> {
            try { restoreDownloaded(); }
            catch (Exception error) { synchronized (this) { phase = "idle"; message = "可手动检查新版，当前账本不受影响。"; } }
            finally {
                recoverInstallSession();
                UpdatePolicy.CheckReason pending;
                synchronized (this) { busy = false; pending = checkGate.restored(); }
                notifyChanged(); if (pending != null) requestCheck(pending);
            }
        });
    }
    private void opened() {
        synchronized (this) {
            activityOpened = true; Activity owner = permissionOwner.get();
            if (installPermission.releaseIfOwnerGone(owner != null, owner != null && owner.isDestroyed(), owner != null && owner.isChangingConfigurations())) permissionOwner.clear();
        }
        if (preferences.getInt("activeSessionId", -1) >= 0) worker.execute(() -> { recoverInstallSession(); notifyChanged(); });
        requestCheck(UpdatePolicy.CheckReason.OPEN);
    }
    public void onActivityStarted() { if (openLifecycle.onStart()) opened(); }
    public void onActivityStopped(boolean temporary) { openLifecycle.onStop(temporary); }
    public void onLauncherIntent() { if (openLifecycle.onLauncherIntent()) opened(); }
    public void onSecondaryActivityStarted(boolean reopened) {
        boolean cold; synchronized (this) { cold = !activityOpened; }
        if (cold || reopened) { openLifecycle.openedElsewhere(); opened(); }
    }
    public synchronized void attach(Listener next) {
        listener = new WeakReference<>(next);
        Activity owner = permissionOwner.get();
        if (installPermission.isWaiting() && owner != null && owner.isChangingConfigurations() && next instanceof Activity) permissionOwner = new WeakReference<>((Activity) next);
        notifyChanged();
    }
    public synchronized void detach(Listener previous) { if (listener.get() == previous) listener.clear(); }
    private void notifyChanged() { main.post(() -> { Listener target; synchronized (this) { target = listener.get(); } if (target != null) target.onUpdaterChanged(); }); }
    public synchronized Snapshot snapshot() {
        Snapshot state = new Snapshot(); state.phase = phase; state.message = message; state.version = candidate == null ? "" : candidate.version; state.size = candidate == null ? 0 : candidate.size;
        state.notes = candidate == null ? "" : candidate.notes;
        state.sourceMode = getSourceMode(); state.sourceLabel = sourceLabel;
        state.downloaded = downloaded; state.busy = busy || phase.equals("installing") || installPermission.isWaiting(); state.canDownload = !state.busy && candidate != null && readyFile == null; state.canInstall = !state.busy && candidate != null && readyFile != null;
        state.checkedAt = preferences.getLong("lastCheckAt", 0); return state;
    }
    public synchronized UpdatePolicy.Release consumeOffer() { if (!offerPending || busy || candidate == null) return null; offerPending = false; return candidate; }
    public synchronized boolean consumeInstallRequest() { if (!installRequested || busy || readyFile == null) return false; installRequested = false; return true; }
    public synchronized Intent consumeConfirmation() { Intent result = pendingConfirmation; pendingConfirmation = null; return result; }
    public String getSourceMode() {
        String mode = preferences.getString("sourceMode", "auto");
        return mode != null && mode.matches("auto|github|gh-proxy|ghfast") ? mode : "auto";
    }
    public synchronized void setSourceMode(String mode) throws Exception {
        if (busy || phase.equals("installing")) throw new Exception("请先取消或完成当前更新，再更换线路");
        UpdateSources.manifestEndpoints(mode);
        preferences.edit().putString("sourceMode", mode).apply();
        sourceLabel = mode.equals("auto") ? "自动选择" : UpdateSources.manifestEndpoints(mode).get(0).label;
        notifyChanged();
    }
    private long highestCode() { return preferences.getLong("highestVerifiedCode", 0); }
    private void rememberVerified(UpdatePolicy.Release release) {
        if (release.versionCode < highestCode()) return;
        preferences.edit().putLong("highestVerifiedCode", release.versionCode).putString("highestVerifiedSha256", release.sha256).putLong("highestVerifiedSize", release.size).apply();
    }
    private void validateRemembered(UpdatePolicy.Release release, long installedCode) throws Exception {
        UpdatePolicy.validateVersionFence(release, installedCode, highestCode(), preferences.getString("highestVerifiedSha256", ""), preferences.getLong("highestVerifiedSize", 0));
    }
    private UpdateTransport.Listener transferListener(UpdateSourceClient.Session session, boolean downloading) {
        return new UpdateTransport.Listener() {
            @Override public void onStage(String stage) {
                synchronized (AppUpdater.this) {
                    if (activeSession != session || session.isCancelled() || downloading && cancelDownload) return;
                    message = stage; UpdateSources.Endpoint source = session.currentSource(); if (source != null) sourceLabel = source.label;
                }
                notifyChanged();
            }
            @Override public void onProgress(long bytes) {
                synchronized (AppUpdater.this) { if (activeSession != session || session.isCancelled() || downloading && cancelDownload) return; if (downloading) downloaded = bytes; }
                notifyChanged();
            }
        };
    }
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
        if (!base.exists() && !new File(base.getPath() + ".bak").exists()) { synchronized (this) { phase = "idle"; message = "每次打开应用会自动检查公开版本。"; } return; }
        byte[] bytes; try (InputStream input = metadata.openRead()) { bytes = readLimited(input, UpdatePolicy.MAX_MANIFEST_BYTES); }
        UpdatePolicy.Release release = UpdatePolicy.readVerifiedRelease(bytes, publicKey());
        if (!release.certificateSha256.equals(certificate(installedInfo()))) throw new Exception("更新清单的签名身份与当前应用不一致");
        long installedCode = installedVersionCode();
        if (release.versionCode <= installedCode) { clearActiveSession(); synchronized (this) { candidate = null; candidateEnvelope = null; readyFile = null; phase = "idle"; message = "当前版本已安装，账本保留在本机。"; } return; }
        if (release.minSdk > Build.VERSION.SDK_INT) throw new Exception("新版需要更高的安卓系统，当前版本仍可正常使用");
        validateRemembered(release, installedCode); rememberVerified(release);
        File apk = artifactFile(release); boolean ready = false;
        if (apk.isFile()) { try { verifyApk(apk, release); ready = true; } catch (Exception ignored) { /* Never install a stale or altered cached APK. */ } }
        synchronized (this) { candidate = release; candidateEnvelope = bytes; readyFile = ready ? apk : null; phase = ready ? "ready" : "available"; message = ready ? "安装包已校验，可继续覆盖更新。" : "发现新版 " + release.version + "，可选择下载更新。"; }
    }
    public void check(boolean manual) {
        requestCheck(manual ? UpdatePolicy.CheckReason.MANUAL : UpdatePolicy.CheckReason.PERIODIC);
    }
    private void requestCheck(UpdatePolicy.CheckReason reason) {
        final UpdateSourceClient.Session session; final String sourceMode;
        synchronized (this) {
            long now = System.currentTimeMillis(), last = preferences.getLong("lastCheckAt", 0);
            if (!checkGate.request(reason, busy || phase.equals("installing") || installPermission.isWaiting(), now, last)) return;
            busy = true; phase = "checking"; message = "正在检查公开更新版本…"; downloaded = 0;
            session = new UpdateSourceClient.Session(); activeSession = session; sourceMode = getSourceMode();
        }
        notifyChanged();
        worker.execute(() -> {
            try {
                long installedCode = installedVersionCode();
                UpdateSourceClient.ManifestResult result = UpdateSourceClient.checkManifest(sourceMode, publicKey(), installedCode, highestCode(), preferences.getString("highestVerifiedSha256", ""), preferences.getLong("highestVerifiedSize", 0), certificate(installedInfo()), Build.VERSION.SDK_INT, session, transferListener(session, false));
                byte[] bytes = result.envelope; UpdatePolicy.Release release = result.release;
                synchronized (this) { sourceLabel = result.source.label; }
                if (release.versionCode <= installedCode) {
                    rememberVerified(release);
                    synchronized (this) { candidate = null; candidateEnvelope = null; readyFile = null; offerPending = false; phase = "idle"; message = "当前已是最新版本。"; }
                } else {
                    if (!release.certificateSha256.equals(certificate(installedInfo()))) throw new Exception("更新清单的签名身份与当前应用不一致");
                    File apk = artifactFile(release); boolean ready = false;
                    if (apk.isFile()) { try { verifyApk(apk, release); ready = true; } catch (Exception ignored) {} }
                    saveMetadata(bytes);
                    rememberVerified(release);
                    synchronized (this) { candidate = release; candidateEnvelope = bytes; readyFile = ready ? apk : null; offerPending = true; phase = ready ? "ready" : "available"; message = "发现新版 " + release.version + (ready ? "，安装包已准备好。" : "，可选择下载更新。"); }
                }
                preferences.edit().putLong("lastCheckAt", System.currentTimeMillis()).apply();
            } catch (Exception error) { synchronized (this) { phase = readyFile != null ? "ready" : candidate != null ? "available" : "idle"; message = "检查更新未完成：" + safeMessage(error) + "。当前版本与账本不受影响，可稍后重试。"; } }
            finally { synchronized (this) { if (activeSession == session) activeSession = null; busy = false; checkGate.finished(); } notifyChanged(); }
        });
    }
    private static String safeMessage(Exception error) { String value = error.getMessage(); if (value == null || value.length() > 240) return "网络或版本验证失败"; return value; }
    public void download() {
        final UpdatePolicy.Release release; final byte[] envelope; final UpdateSourceClient.Session session; final String sourceMode;
        synchronized (this) {
            if (busy || candidate == null) return;
            if (readyFile != null) { installRequested = true; notifyChanged(); return; }
            release = candidate; envelope = candidateEnvelope.clone(); busy = true; cancelDownload = false; phase = "downloading"; message = "正在选择安装包下载线路…"; downloaded = 0; offerPending = false;
            session = new UpdateSourceClient.Session(); activeSession = session; sourceMode = getSourceMode();
        }
        notifyChanged();
        worker.execute(() -> {
            File partial = null;
            try {
                ensureDirectory(); if (directory.getUsableSpace() > 0 && directory.getUsableSpace() < release.size * 2 + 1024 * 1024) throw new Exception("存储空间不足，请留出安装包大小两倍以上的空间");
                partial = UpdateSourceClient.download(release, directory, sourceMode, session, transferListener(session, true));
                if (cancelDownload) throw new Exception("下载已取消");
                UpdateSources.Endpoint workingSource = session.currentSource();
                if (workingSource != null) preferences.edit().putString("lastWorkingSource", workingSource.id).apply();
                synchronized (this) { downloaded = release.size; message = "下载完成，正在校验安装包…"; } notifyChanged();
                verifyApk(partial, release); if (cancelDownload) throw new Exception("下载已取消");
                File target = artifactFile(release); if (target.exists() && !target.delete()) throw new Exception("无法替换旧的更新缓存");
                if (!partial.renameTo(target)) throw new Exception("无法保存更新安装包"); partial = null; saveMetadata(envelope);
                synchronized (this) {
                    // Order cancellation and readiness atomically, including a
                    // cancellation arriving during the final disk verification.
                    if (cancelDownload || session.isCancelled() || activeSession != session) throw new Exception("下载已取消");
                    readyFile = target; phase = "ready"; message = "下载与校验完成，等待系统确认覆盖更新。"; installRequested = true;
                }
            } catch (Exception error) { synchronized (this) { phase = "available"; message = safeMessage(error) + "。已有应用和账本未改动，可重新下载。"; installRequested = false; } }
            finally { if (partial != null && partial.isFile()) partial.delete(); synchronized (this) { if (activeSession == session) activeSession = null; busy = false; } notifyChanged(); }
        });
    }
    public void cancelDownload() {
        UpdateSourceClient.Session session;
        synchronized (this) {
            if (!phase.equals("downloading")) return;
            cancelDownload = true; session = activeSession; message = "正在取消下载，已有账本不受影响…";
        }
        if (session != null) session.cancel();
        notifyChanged();
    }
    public void openDownloadInBrowser(Activity activity) throws Exception {
        final String address;
        synchronized (this) {
            if (candidate == null) throw new Exception("请先检查并验证新版信息");
            java.util.List<UpdateSources.Endpoint> sources = UpdateSources.downloadEndpoints(candidate, getSourceMode());
            UpdateSources.Endpoint chosen = sources.get(0);
            if (getSourceMode().equals("auto")) {
                String last = preferences.getString("lastWorkingSource", "");
                for (UpdateSources.Endpoint source : sources) if (source.id.equals(last)) { chosen = source; break; }
            }
            address = chosen.url; UpdateSources.validateDownloadUrl(address, candidate.url, true);
        }
        cancelDownload();
        try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(address))); }
        catch (android.content.ActivityNotFoundException error) { throw new Exception("没有找到浏览器，可将电脑下载的安装包传到手机，直接覆盖安装，无需卸载"); }
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
        synchronized (this) { if (busy || phase.equals("installing") || installPermission.isWaiting() || readyFile == null || candidate == null) throw new Exception("安装包尚未准备好，或系统正在处理上一次安装"); }
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            if (!installPermission.begin()) return;
            synchronized (this) { permissionOwner = new WeakReference<>(activity); }
            synchronized (this) { message = "请允许超级账本安装更新，返回后会继续系统安装确认。"; }
            try { activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())), INSTALL_PERMISSION_REQUEST); }
            catch (RuntimeException error) { installPermission.cancel(); synchronized (this) { permissionOwner.clear(); message = "无法打开系统安装授权，请稍后重新点「安装更新」。"; } throw error; }
            finally { notifyChanged(); }
            return;
        }
        beginInstall();
    }
    public void permissionReturned() {
        if (!installPermission.returned()) return;
        synchronized (this) { permissionOwner.clear(); }
        if (context.getPackageManager().canRequestPackageInstalls()) beginInstall();
        else { synchronized (this) { phase = "ready"; message = "安装权限尚未开启。安装包已保留，可在需要时点「安装更新」重试。"; } notifyChanged(); }
    }
    private void beginInstall() {
        final UpdatePolicy.Release release; final File apk;
        synchronized (this) { if (busy || readyFile == null || candidate == null) return; release = candidate; apk = readyFile; busy = true; phase = "installing"; message = "正在准备覆盖安装，请在系统界面确认…"; installRequested = false; pendingConfirmation = null; }
        notifyChanged(); worker.execute(() -> {
            int sessionId = -1;
            try {
                UpdatePolicy.InstallRecovery recovery = recoverInstallSession();
                if (recovery == UpdatePolicy.InstallRecovery.WAIT || recovery == UpdatePolicy.InstallRecovery.COMPLETE) return;
                verifyApk(apk, release);
                if (!context.getPackageManager().canRequestPackageInstalls()) throw new Exception("系统尚未允许本应用安装更新");
                PackageInstaller installer = context.getPackageManager().getPackageInstaller();
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
                synchronized (this) { if (sessionId == preferences.getInt("activeSessionId", -1)) message = "安装已交给安卓系统，等待你确认。若取消，可稍后再次安装。"; }
            } catch (Exception error) {
                if (sessionId >= 0) {
                    UpdatePolicy.InstallRecovery recovery = recoverInstallSession();
                    if (recovery == UpdatePolicy.InstallRecovery.WAIT || recovery == UpdatePolicy.InstallRecovery.COMPLETE) return;
                }
                clearActiveSession(); synchronized (this) { phase = "ready"; message = "安装未完成：" + safeMessage(error) + "。当前应用与账本保留。"; }
            } finally { synchronized (this) { busy = false; } notifyChanged(); }
        });
    }
    private void clearActiveSession() { installPermission.cancel(); permissionOwner.clear(); preferences.edit().remove("activeSessionId").remove("installVersionCode").remove("installStartedAt").remove("awaitingInstallPermission").apply(); }
    public void installerReturned() {
        synchronized (this) { if (phase.equals("installing")) message = "正在等待安卓系统返回安装结果，取消安装不会删除账本。"; }
        notifyChanged(); worker.execute(() -> { recoverInstallSession(); notifyChanged(); });
    }
    private UpdatePolicy.InstallRecovery recoverInstallSession() {
        int sessionId = preferences.getInt("activeSessionId", -1);
        if (sessionId < 0) return UpdatePolicy.InstallRecovery.NONE;
        try {
            PackageInstaller installer = context.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionInfo info = installer.getSessionInfo(sessionId);
            UpdatePolicy.InstallRecovery recovery = UpdatePolicy.recoverInstallation(installedVersionCode(), preferences.getLong("installVersionCode", 0), info != null, info != null && info.isActive(), info != null && info.isSealed());
            synchronized (this) {
                if (sessionId != preferences.getInt("activeSessionId", -1)) return UpdatePolicy.InstallRecovery.NONE;
                if (recovery == UpdatePolicy.InstallRecovery.WAIT) {
                    phase = "installing"; message = "已有更新正在由安卓系统处理，请继续或取消系统安装确认。";
                } else if (recovery == UpdatePolicy.InstallRecovery.COMPLETE) {
                    clearActiveSession(); candidate = null; candidateEnvelope = null; readyFile = null; pendingConfirmation = null; installRequested = false; phase = "idle"; message = "新版已安装，账本保留在本机。";
                } else {
                    // Only an uncommitted, inactive session can be discarded.
                    if (info != null) installer.abandonSession(sessionId);
                    clearActiveSession(); pendingConfirmation = null; installRequested = false; phase = readyFile != null ? "ready" : candidate != null ? "available" : "idle";
                    message = "上次安装已结束，当前应用与账本保留。可再次确认安装更新。";
                }
            }
            return recovery;
        } catch (Exception error) {
            synchronized (this) { if (sessionId != preferences.getInt("activeSessionId", -1)) return UpdatePolicy.InstallRecovery.NONE; phase = "installing"; message = "暂时无法确认系统安装状态，已有安装任务保留；重新打开后会再次确认。"; }
            return UpdatePolicy.InstallRecovery.WAIT;
        }
    }
    private void finishInstallSession(int sessionId, int status) {
        synchronized (this) {
            if (sessionId != preferences.getInt("activeSessionId", -1)) return;
            clearActiveSession(); pendingConfirmation = null; installRequested = false;
            if (status == PackageInstaller.STATUS_SUCCESS) { candidate = null; candidateEnvelope = null; readyFile = null; phase = "idle"; message = "新版已安装，重新打开即可使用。账本保留在本机。"; }
            else { phase = readyFile != null ? "ready" : candidate != null ? "available" : "idle"; message = status == PackageInstaller.STATUS_FAILURE_ABORTED ? "已取消安装，当前版本与账本保留，可随时重试。" : status == PackageInstaller.STATUS_FAILURE_STORAGE ? "系统存储空间不足，安装包已保留，请清理空间后重试。" : "系统未完成安装，当前版本与账本保留，可重试。"; }
        }
        notifyChanged();
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
            finishInstallSession(sessionId, status); return;
        }
        notifyChanged();
    }
}
