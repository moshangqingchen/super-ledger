package com.moneylab.superledger.mobile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;

/** Bounded HTTPS transport. The caller never waits indefinitely for DNS, headers or a read. */
public final class UpdateTransport {
    private UpdateTransport() {}
    public interface Listener {
        void onStage(String message);
        void onProgress(long bytes);
    }
    interface ConnectionFactory { HttpsURLConnection open(String address) throws Exception; }
    static final class Limits {
        final long idleNanos, totalNanos, pollNanos;
        Limits(long idleMillis, long totalMillis, long pollMillis) {
            if (idleMillis < 1 || totalMillis < 1 || pollMillis < 1) throw new IllegalArgumentException("Invalid transport limits");
            idleNanos = TimeUnit.MILLISECONDS.toNanos(idleMillis); totalNanos = TimeUnit.MILLISECONDS.toNanos(totalMillis); pollNanos = TimeUnit.MILLISECONDS.toNanos(pollMillis);
        }
    }
    private static final Limits MANIFEST_LIMITS = new Limits(45000, 45000, 100);
    private static final Limits DOWNLOAD_LIMITS = new Limits(45000, 180000, 100);
    // A DNS call can ignore interruption on some Android builds. At most two
    // abandoned calls can remain; retries never create an unbounded thread queue.
    private static final ThreadPoolExecutor NETWORK = pool("ledger-update-network");
    private static final ThreadPoolExecutor CLOSER = pool("ledger-update-close");
    private static ThreadPoolExecutor pool(final String name) {
        final AtomicInteger counter = new AtomicInteger();
        ThreadFactory factory = task -> { Thread thread = new Thread(task, name + "-" + counter.incrementAndGet()); thread.setDaemon(true); return thread; };
        return new ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS, new SynchronousQueue<Runnable>(), factory, new ThreadPoolExecutor.AbortPolicy());
    }
    static final ConnectionFactory CONNECTIONS = address -> (HttpsURLConnection) new URL(address).openConnection();
    private static final class Failure extends IOException { Failure(String message) { super(message); } }
    static final class RetryableFailure extends IOException { RetryableFailure(String message) { super(message); } }

    /** One-use operation. cancel() changes only state; socket cleanup is never done on the UI thread. */
    public static final class Operation {
        private volatile boolean cancelled, finished;
        private boolean started;
        private volatile long lastProgressNanos;
        private long startedNanos;
        private volatile HttpsURLConnection active;
        public void cancel() { cancelled = true; }
        private synchronized void start() throws Exception {
            if (started) throw new Failure("更新任务已结束，请重新发起下载");
            started = true; startedNanos = lastProgressNanos = System.nanoTime(); check();
        }
        private void check() throws Exception {
            if (cancelled || finished || Thread.currentThread().isInterrupted()) throw new Failure("下载已取消");
        }
        private void checkTime(Limits limits) throws Exception {
            check(); long now = System.nanoTime();
            if (now - startedNanos >= limits.totalNanos) throw new RetryableFailure("下载耗时过长，已停止。可稍后重试或用浏览器下载");
            if (now - lastProgressNanos >= limits.idleNanos) throw new RetryableFailure("连接长时间没有收到数据，已停止。请检查手机网络，或用浏览器下载");
        }
        private void register(HttpsURLConnection connection) throws Exception { active = connection; check(); }
        private void clear(HttpsURLConnection connection) { if (active == connection) active = null; }
        private void received() throws Exception { check(); lastProgressNanos = System.nanoTime(); }
        private synchronized void stage(Listener listener, String value) throws Exception { check(); if (listener != null) listener.onStage(value); }
        private synchronized void progress(Listener listener, long value) throws Exception { check(); if (listener != null) listener.onProgress(value); }
        private synchronized void finish() { finished = true; }
    }
    private static void disconnectAsync(HttpsURLConnection connection) {
        if (connection == null) return;
        try { CLOSER.execute(() -> { try { connection.disconnect(); } catch (RuntimeException ignored) {} }); }
        catch (RejectedExecutionException ignored) { /* Bounded workers still own their connections and disconnect in finally. */ }
    }
    private static Exception usefulFailure(Throwable error) {
        if (error instanceof Failure) return (Failure) error;
        if (error instanceof RetryableFailure) return (RetryableFailure) error;
        if (error instanceof UnknownHostException) return new RetryableFailure("无法解析更新下载地址，请检查手机网络或用浏览器下载");
        if (error instanceof SocketTimeoutException) return new RetryableFailure("更新连接或接收数据超时，请重试或用浏览器下载");
        if (error instanceof SSLException) return new Failure("更新连接的安全验证未通过，请检查手机时间和网络");
        if (error instanceof IOException) return new RetryableFailure("更新连接中断或缓存写入失败，请检查网络与存储空间后重试");
        return error instanceof Exception ? (Exception) error : new Failure("更新传输未完成，请重试");
    }
    private static <T> T run(Operation operation, Limits limits, Callable<T> task) throws Exception {
        if (operation == null) throw new IllegalArgumentException("Operation is required");
        operation.start(); Future<T> future = null; boolean success = false;
        try {
            try { future = NETWORK.submit(task); }
            catch (RejectedExecutionException error) { throw new RetryableFailure("之前的网络连接仍在释放，请稍后重试，或用浏览器下载"); }
            for (;;) {
                operation.checkTime(limits);
                try {
                    T result = future.get(limits.pollNanos, TimeUnit.NANOSECONDS);
                    operation.checkTime(limits); success = true; return result;
                } catch (TimeoutException ignored) { /* Cancellation and deadlines are independent of the network call. */ }
                catch (ExecutionException error) { throw usefulFailure(error.getCause()); }
            }
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new Failure("下载已取消"); }
        finally {
            operation.finish();
            if (!success) { operation.cancelled = true; if (future != null) future.cancel(true); disconnectAsync(operation.active); }
        }
    }
    private static HttpsURLConnection open(String address, Operation operation, ConnectionFactory factory, String accept) throws Exception {
        operation.check(); HttpsURLConnection connection = factory.open(address);
        if (connection == null) throw new Failure("无法创建安全更新连接");
        operation.active = connection;
        try {
            operation.check();
            // Use the Android HTTPS/system proxy configuration. No Proxy.NO_PROXY,
            // replacement trust manager, or direct fallback is introduced here.
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setUseCaches(false);
            connection.setRequestProperty("Accept-Encoding", "identity"); connection.setRequestProperty("Accept", accept); connection.setRequestProperty("User-Agent", "SuperLedger-Mobile-Updater");
            connection.setRequestProperty("Cache-Control", "no-cache");
            operation.register(connection); return connection;
        } catch (Exception error) { close(connection, operation); throw error; }
    }
    private static void close(HttpsURLConnection connection, Operation operation) {
        try { connection.disconnect(); } catch (RuntimeException ignored) {}
        finally { operation.clear(connection); }
    }
    private static void encoding(HttpsURLConnection connection) throws Exception {
        String value = connection.getContentEncoding();
        if (value != null && !value.isEmpty() && !value.equalsIgnoreCase("identity")) throw new Failure("更新传输编码不符合要求");
    }
    private static Exception httpFailure(int status, boolean manifest) {
        String message = manifest ? status == 404 ? "公开更新清单暂未发布" : "版本服务返回状态 " + status : "下载服务返回状态 " + status;
        return status == 403 || status == 404 || status == 408 || status == 429 || status >= 500 && status <= 599 ? new RetryableFailure(message) : new Failure(message);
    }
    public static byte[] fetchManifest(Operation operation) throws Exception { return fetchManifest(operation, CONNECTIONS, MANIFEST_LIMITS); }
    static byte[] fetchManifest(Operation operation, ConnectionFactory factory, Limits limits) throws Exception {
        return fetchManifest(UpdatePolicy.MANIFEST_URL, operation, factory, limits);
    }
    static byte[] fetchManifest(String address, Operation operation, ConnectionFactory factory, Limits limits) throws Exception {
        UpdateSources.validateManifestUrl(address);
        return run(operation, limits, () -> {
            operation.check(); HttpsURLConnection connection = open(address, operation, factory, "application/json");
            try {
                int status = connection.getResponseCode(); operation.check();
                if (status != 200) throw httpFailure(status, true);
                encoding(connection); long declared = connection.getContentLengthLong();
                if (declared > UpdatePolicy.MAX_MANIFEST_BYTES) throw new Failure("版本清单超过允许大小");
                ByteArrayOutputStream result = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[8192];
                    for (;;) {
                        operation.check(); int count = input.read(buffer); if (count == -1) break;
                        operation.check(); if (count == 0) continue;
                        if (result.size() + count > UpdatePolicy.MAX_MANIFEST_BYTES) throw new Failure("版本清单超过允许大小");
                        result.write(buffer, 0, count); operation.received();
                    }
                }
                operation.check();
                if (declared >= 0 && declared != result.size()) throw new RetryableFailure("版本清单下载不完整");
                return result.toByteArray();
            } finally { close(connection, operation); }
        });
    }
    public static void download(UpdatePolicy.Release release, File outputFile, Operation operation, Listener listener) throws Exception {
        if (release == null) throw new IllegalArgumentException("Verified release is required");
        download(release.url, release.size, outputFile, operation, listener, CONNECTIONS, DOWNLOAD_LIMITS);
    }
    static void download(String address, long expectedBytes, File outputFile, Operation operation, Listener listener, ConnectionFactory factory, Limits limits) throws Exception {
        download(address, address, expectedBytes, outputFile, operation, listener, factory, limits);
    }
    static void download(String address, String canonical, long expectedBytes, File outputFile, Operation operation, Listener listener, ConnectionFactory factory, Limits limits) throws Exception {
        UpdateSources.validateDownloadUrl(address, canonical, true);
        if (expectedBytes < 1 || expectedBytes > UpdatePolicy.MAX_APK_BYTES) throw new Failure("安装包大小超出范围");
        if (outputFile == null || outputFile.exists()) throw new Failure("下载临时文件已存在，请重新发起下载");
        boolean success = false;
        try {
            run(operation, limits, () -> { transfer(address, canonical, expectedBytes, outputFile, operation, listener, factory); return null; }); success = true;
        } finally {
            // If a delayed DNS/read returns after the caller has timed out, the
            // network task also deletes this same unique temporary file in its finally.
            if (!success && outputFile.isFile()) outputFile.delete();
        }
    }
    private static void transfer(String initialAddress, String canonical, long expectedBytes, File outputFile, Operation operation, Listener listener, ConnectionFactory factory) throws Exception {
        String address = initialAddress; boolean success = false, ownsFile = false;
        try {
            for (int redirects = 0; redirects <= 5; redirects++) {
                operation.check(); UpdateSources.validateDownloadUrl(address, canonical, redirects == 0);
                operation.stage(listener, redirects == 0 ? "正在连接安装包下载服务…" : "正在连接 GitHub 安装包服务器…");
                HttpsURLConnection connection = open(address, operation, factory, "application/octet-stream");
                try {
                    int status = connection.getResponseCode(); operation.check();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = connection.getHeaderField("Location");
                        if (location == null || redirects == 5) throw new Failure("下载跳转次数或地址无效");
                        address = new URI(address).resolve(location).toString(); UpdateSources.validateDownloadUrl(address, canonical, false); continue;
                    }
                    if (status != 200) throw httpFailure(status, false);
                    encoding(connection); long declared = connection.getContentLengthLong();
                    if (declared >= 0 && declared != expectedBytes) throw new Failure("安装包大小与签名清单不一致");
                    operation.stage(listener, "连接已建立，正在等待安装包数据…"); operation.check();
                    if (!outputFile.createNewFile()) throw new Failure("下载临时文件已存在，请重新发起下载"); ownsFile = true;
                    long total = 0, lastNotification = 0; boolean first = true;
                    try (InputStream input = connection.getInputStream()) {
                        operation.check();
                        try (FileOutputStream output = new FileOutputStream(outputFile, false)) {
                            byte[] bytes = new byte[65536];
                            for (;;) {
                                operation.check(); int count = input.read(bytes); if (count == -1) break;
                                operation.check(); if (count == 0) continue;
                                total += count;
                                if (total > expectedBytes || total > UpdatePolicy.MAX_APK_BYTES) throw new Failure("安装包超过签名清单声明的大小");
                                output.write(bytes, 0, count); operation.received();
                                if (first) { first = false; operation.stage(listener, "正在下载安装包…"); }
                                long now = System.nanoTime();
                                if (lastNotification == 0 || now - lastNotification >= TimeUnit.MILLISECONDS.toNanos(400)) { lastNotification = now; operation.progress(listener, total); }
                            }
                            operation.check(); output.flush(); output.getFD().sync();
                        }
                    }
                    operation.check(); if (total != expectedBytes) throw new RetryableFailure("安装包下载不完整");
                    operation.progress(listener, total); success = true; return;
                } finally { close(connection, operation); }
            }
            throw new Failure("下载跳转过多");
        } finally { if (ownsFile && (!success || operation.cancelled || operation.finished) && outputFile.isFile()) outputFile.delete(); }
    }
}
