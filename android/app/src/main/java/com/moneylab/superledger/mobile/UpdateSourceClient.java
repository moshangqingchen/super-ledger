package com.moneylab.superledger.mobile;

import java.io.File;
import java.io.IOException;
import java.security.PublicKey;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Chooses registered routes without changing the publisher's signed bytes or trust key. */
public final class UpdateSourceClient {
    private UpdateSourceClient() {}
    static final class Timing {
        final long checkMillis, downloadMillis, idleMillis, pollMillis;
        Timing(long checkMillis, long downloadMillis, long idleMillis, long pollMillis) {
            if (checkMillis < 1 || downloadMillis < 1 || idleMillis < 1 || pollMillis < 1) throw new IllegalArgumentException("Invalid update timing");
            this.checkMillis = checkMillis; this.downloadMillis = downloadMillis; this.idleMillis = idleMillis; this.pollMillis = pollMillis;
        }
    }
    private static final Timing TIMING = new Timing(45000, 180000, 12000, 100);
    public static final class ManifestResult {
        public final byte[] envelope;
        public final UpdatePolicy.Release release;
        public final UpdateSources.Endpoint source;
        private ManifestResult(byte[] envelope, UpdatePolicy.Release release, UpdateSources.Endpoint source) { this.envelope = envelope; this.release = release; this.source = source; }
    }
    /** A whole check/download owns one session; each route owns a separate Operation. */
    public static final class Session {
        private volatile boolean cancelled, finished;
        private boolean started;
        private volatile UpdateTransport.Operation active;
        private volatile UpdateSources.Endpoint source;
        private long startedNanos, totalNanos;
        public void cancel() { cancelled = true; UpdateTransport.Operation current = active; if (current != null) current.cancel(); }
        public boolean isCancelled() { return cancelled; }
        public UpdateSources.Endpoint currentSource() { return source; }
        private synchronized void begin(long millis) throws Exception {
            if (started) throw new IOException("更新任务已结束，请重新发起");
            started = true; startedNanos = System.nanoTime(); totalNanos = TimeUnit.MILLISECONDS.toNanos(millis); check();
        }
        private void check() throws Exception {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("下载已取消");
            if (finished) throw new IOException("更新任务已结束");
            if (System.nanoTime() - startedNanos >= totalNanos) throw new IOException("本次更新连接已超时，请稍后重试或手动选择线路");
        }
        private UpdateTransport.Limits limits(Timing timing) throws Exception {
            check(); long left = TimeUnit.NANOSECONDS.toMillis(totalNanos - (System.nanoTime() - startedNanos));
            if (left < 1) throw new IOException("本次更新连接已超时，请稍后重试或手动选择线路");
            return new UpdateTransport.Limits(Math.min(timing.idleMillis, left), left, Math.min(timing.pollMillis, left));
        }
        private void bind(UpdateTransport.Operation operation, UpdateSources.Endpoint endpoint) throws Exception {
            check(); active = operation; source = endpoint;
            if (cancelled) operation.cancel(); check();
        }
        private void unbind(UpdateTransport.Operation operation) { if (active == operation) active = null; }
        private boolean canEmit(UpdateTransport.Operation operation) { return !cancelled && !finished && active == operation && System.nanoTime() - startedNanos < totalNanos; }
        private void finish() { finished = true; UpdateTransport.Operation current = active; if (current != null) current.cancel(); active = null; }
    }
    private static void stage(Session session, UpdateTransport.Listener listener, String message) throws Exception {
        session.check(); if (listener != null) listener.onStage(message); session.check();
    }
    private static UpdateTransport.Listener listener(Session session, UpdateTransport.Operation operation, UpdateSources.Endpoint endpoint, UpdateTransport.Listener target) {
        return new UpdateTransport.Listener() {
            public void onStage(String message) { if (target != null && session.canEmit(operation)) target.onStage(endpoint.label + " · " + message); }
            public void onProgress(long bytes) { if (target != null && session.canEmit(operation)) target.onProgress(bytes); }
        };
    }
    private static void identity(UpdatePolicy.Release release, String certificate, int sdk) throws Exception {
        if (certificate == null || !release.certificateSha256.equalsIgnoreCase(certificate)) throw new UpdatePolicy.IntegrityException("更新清单的签名身份与当前应用不一致");
        if (release.minSdk > sdk) throw new UpdatePolicy.IntegrityException("新版需要更高的安卓系统，当前版本仍可正常使用");
    }
    public static ManifestResult checkManifest(String mode, PublicKey key, long installedCode, long highestCode, String highestSha, long highestSize, String expectedCertificate, int deviceSdk, Session session, UpdateTransport.Listener listener) throws Exception {
        return checkManifest(mode, key, installedCode, highestCode, highestSha, highestSize, expectedCertificate, deviceSdk, session, listener, UpdateTransport.CONNECTIONS, TIMING);
    }
    static ManifestResult checkManifest(String mode, PublicKey key, long installedCode, long highestCode, String highestSha, long highestSize, String expectedCertificate, int deviceSdk, Session session, UpdateTransport.Listener listener, UpdateTransport.ConnectionFactory connections, Timing timing) throws Exception {
        List<UpdateSources.Endpoint> sources = UpdateSources.manifestEndpoints(mode); session.begin(timing.checkMillis);
        ManifestResult current = null; boolean stale = false;
        try {
            for (int index = 0; index < sources.size(); index++) {
                UpdateSources.Endpoint source = sources.get(index); UpdateTransport.Operation attempt = new UpdateTransport.Operation(); session.bind(attempt, source);
                try {
                    stage(session, listener, "正在通过" + source.label + "检查更新…");
                    byte[] bytes = UpdateTransport.fetchManifest(source.url, attempt, connections, session.limits(timing)); session.check();
                    // A malformed/signed-by-someone-else response is never silently
                    // converted to a network failure or an unverified fallback.
                    UpdatePolicy.Release release = UpdatePolicy.readVerifiedRelease(bytes, key);
                    identity(release, expectedCertificate, deviceSdk);
                    UpdatePolicy.validateVersionFence(release, installedCode, highestCode, highestSha, highestSize);
                    if (current != null && release.versionCode == current.release.versionCode && (!release.sha256.equals(current.release.sha256) || release.size != current.release.size)) throw new UpdatePolicy.IntegrityException("不同更新源对同一版本提供了不同安装包，已停止更新");
                    current = new ManifestResult(bytes, release, source); session.check();
                    if (release.versionCode > installedCode || sources.size() == 1) return current;
                    // A mirror holding exactly the installed version may be stale:
                    // consult remaining registered sources before saying up to date.
                } catch (UpdatePolicy.StaleReleaseException error) {
                    stale = true; session.check();
                    if (index + 1 < sources.size()) stage(session, listener, source.label + "的版本较旧，正在查询下一条线路…");
                } catch (UpdateTransport.RetryableFailure error) {
                    session.check();
                    if (index + 1 < sources.size()) stage(session, listener, source.label + "暂不可用，正在自动切换线路…");
                } finally { session.unbind(attempt); }
            }
            session.check(); if (current != null) { session.source = current.source; return current; }
            throw new IOException(stale ? "更新源的版本尚未同步，请稍后重试；已发现的新版与账本仍保留" : "所选更新线路暂时无法连接，请稍后重试或切换线路");
        } finally { session.finish(); }
    }
    public static File download(UpdatePolicy.Release release, File directory, String mode, Session session, UpdateTransport.Listener listener) throws Exception {
        return download(release, directory, mode, session, listener, UpdateTransport.CONNECTIONS, TIMING);
    }
    static File download(UpdatePolicy.Release release, File directory, String mode, Session session, UpdateTransport.Listener target, UpdateTransport.ConnectionFactory connections, Timing timing) throws Exception {
        if (directory == null || !directory.isDirectory()) throw new IOException("无法使用更新缓存目录，请检查存储空间");
        List<UpdateSources.Endpoint> sources = UpdateSources.downloadEndpoints(release, mode); session.begin(timing.downloadMillis);
        try {
            for (int index = 0; index < sources.size(); index++) {
                UpdateSources.Endpoint source = sources.get(index); UpdateTransport.Operation attempt = new UpdateTransport.Operation(); session.bind(attempt, source);
                File partial = new File(directory, "download-" + release.versionCode + "-" + UUID.randomUUID() + ".part.apk"); boolean keep = false;
                try {
                    stage(session, target, "正在通过" + source.label + "连接下载…");
                    if (target != null && session.canEmit(attempt)) target.onProgress(0);
                    UpdateTransport.download(source.url, release.url, release.size, partial, attempt, listener(session, attempt, source, target), connections, session.limits(timing));
                    session.check(); stage(session, target, source.label + " · 正在核对安装包…");
                    // Once bytes have arrived, hash/identity errors fail closed;
                    // only transport availability failures permit another route.
                    UpdatePolicy.verifyFile(partial, release); session.check(); keep = true; return partial;
                } catch (UpdateTransport.RetryableFailure error) {
                    session.check();
                    if (index + 1 < sources.size()) stage(session, target, source.label + "暂不可用，正在自动切换线路…");
                } finally {
                    session.unbind(attempt); if (!keep && partial.isFile()) partial.delete();
                }
            }
            throw new IOException("所选下载线路均未完成，请稍后重试或手动选择线路");
        } finally { session.finish(); }
    }
}
