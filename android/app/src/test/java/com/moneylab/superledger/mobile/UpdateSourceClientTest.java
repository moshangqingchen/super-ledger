package com.moneylab.superledger.mobile;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;

/** Every HTTPS connection is a local fake. No real DNS, sockets, or Android runtime. */
public final class UpdateSourceClientTest {
    private static final byte[] APK = new byte[]{80, 75, 1, 2, 3, 4};
    private static final String CERT = "fd5a4af713362682fd1fe4e638decb05077b4ec672966ce3bd75b80558d7e785";
    private static final UpdateSourceClient.Timing NORMAL = new UpdateSourceClient.Timing(2000, 2000, 400, 5);
    private static final UpdateSourceClient.Timing QUICK = new UpdateSourceClient.Timing(1000, 1000, 90, 5);
    private static int checks;
    private static KeyPair keys;
    private interface Task { void run() throws Exception; }
    private interface Condition { boolean test() throws Exception; }
    private static void check(boolean condition, String name) { checks++; if (!condition) throw new AssertionError(name); }
    private static Exception failure(Task task) throws Exception {
        try { task.run(); throw new AssertionError("Expected failure"); }
        catch (AssertionError error) { throw error; }
        catch (Exception error) { check(error.getMessage() != null && !error.getMessage().contains("sensitive-query"), "No untrusted URL/query in errors"); return error; }
    }
    private static void until(Condition condition, String name) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!condition.test() && System.nanoTime() < end) Thread.sleep(5);
        check(condition.test(), name);
    }
    private static final class Gate {
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        void block() { entered.countDown(); boolean done = false; while (!done) { try { release.await(); done = true; } catch (InterruptedException ignored) {} } }
        void await() throws Exception { check(entered.await(2, TimeUnit.SECONDS), "Reached controlled blocking point"); }
        void open() { release.countDown(); }
    }
    private static final class Async {
        volatile Exception error; final Thread thread;
        Async(Task task) { thread = new Thread(() -> { try { task.run(); } catch (Exception error) { this.error = error; } }); thread.setDaemon(true); thread.start(); }
        void failed(String contains) throws Exception { thread.join(1500); check(!thread.isAlive(), "Coordinator returned without blocked request"); check(error != null && error.getMessage().contains(contains), "Expected failure " + contains + ": " + error); }
    }
    private static class Fake extends HttpsURLConnection {
        final byte[] bytes; int status = 200; String location; Gate headers; InputStream input;
        final AtomicInteger closed = new AtomicInteger();
        Fake(byte[] bytes) throws Exception { super(new URL(UpdatePolicy.MANIFEST_URL)); this.bytes = bytes; }
        public int getResponseCode() { if (headers != null) headers.block(); return status; }
        public String getHeaderField(String key) { return "Location".equalsIgnoreCase(key) ? location : null; }
        public long getContentLengthLong() { return bytes.length; }
        public String getContentEncoding() { return null; }
        public InputStream getInputStream() { return input == null ? new ByteArrayInputStream(bytes) : input; }
        public void disconnect() { closed.incrementAndGet(); }
        public boolean usingProxy() { return false; }
        public void connect() {}
        public String getCipherSuite() { return "fake"; }
        public Certificate[] getLocalCertificates() { return null; }
        public Certificate[] getServerCertificates() { return null; }
    }
    private static final class Events implements UpdateTransport.Listener {
        final List<String> messages = Collections.synchronizedList(new ArrayList<String>());
        final List<Long> progress = Collections.synchronizedList(new ArrayList<Long>());
        public void onStage(String text) { messages.add(text); }
        public void onProgress(long value) { progress.add(value); }
    }
    private static JSONObject payload(int code, String hash) throws Exception {
        String version = code == 10301 ? "1.3.1" : code == 10302 ? "1.3.2" : "1.3.3";
        return new JSONObject().put("schema", 1).put("repository", UpdatePolicy.REPOSITORY).put("publishedAt", "2026-11-06T12:00:00Z")
            .put("android", new JSONObject().put("version", version).put("versionCode", code).put("url", "https://github.com/" + UpdatePolicy.REPOSITORY + "/releases/download/android-v" + version + "/SuperLedger-Mobile-" + version + ".apk")
                .put("size", APK.length).put("sha256", hash).put("certificateSha256", CERT).put("packageName", UpdatePolicy.PACKAGE_NAME).put("minSdk", 26).put("notes", "多源更新测试"));
    }
    private static byte[] signed(JSONObject payload) throws Exception {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8); Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(keys.getPrivate()); signer.update(bytes);
        return new JSONObject().put("schema", 1).put("payload", Base64.getEncoder().encodeToString(bytes)).put("signature", Base64.getEncoder().encodeToString(signer.sign())).toString().getBytes(StandardCharsets.UTF_8);
    }
    private static UpdateSourceClient.ManifestResult manifest(String mode, long installed, long highest, String hash, long size, UpdateSourceClient.Session session, UpdateTransport.Listener listener, UpdateTransport.ConnectionFactory factory, UpdateSourceClient.Timing timing) throws Exception {
        return UpdateSourceClient.checkManifest(mode, keys.getPublic(), installed, highest, hash, size, CERT, 35, session, listener, factory, timing);
    }
    private static File download(UpdatePolicy.Release release, File folder, String mode, UpdateSourceClient.Session session, UpdateTransport.Listener events, UpdateTransport.ConnectionFactory factory, UpdateSourceClient.Timing timing) throws Exception {
        return UpdateSourceClient.download(release, folder, mode, session, events, factory, timing);
    }
    public static void main(String[] args) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); keys = generator.generateKeyPair();
        String digest = UpdatePolicy.sha256(APK); byte[] valid = signed(payload(10302, digest));
        UpdatePolicy.Release release = UpdatePolicy.readVerifiedRelease(valid, keys.getPublic());
        File directory = Files.createTempDirectory("ledger-source-client-test-").toFile();
        try {
            AtomicInteger opens = new AtomicInteger(); Events firstEvents = new Events(); UpdateSourceClient.Session firstSession = new UpdateSourceClient.Session();
            UpdateSourceClient.ManifestResult result = manifest("auto", 10301, 0, "", 0, firstSession, firstEvents, address -> { if (opens.incrementAndGet() == 1) throw new UnknownHostException(); return new Fake(valid); }, NORMAL);
            check(opens.get() == 2 && result.source.id.equals("ghfast"), "First DNS failure automatically selects second source");
            check(Arrays.equals(result.envelope, valid) && result.release.versionCode == 10302, "Selected manifest retains exact signed bytes");
            check(firstSession.currentSource().id.equals("ghfast"), "Successful route remains available to UI");
            check(firstEvents.messages.toString().contains("自动切换"), "Fallback stage is visible");

            AtomicInteger originalOnly = new AtomicInteger();
            result = manifest("github", 10301, 0, "", 0, new UpdateSourceClient.Session(), null, address -> { check(address.equals(UpdatePolicy.MANIFEST_URL), "Manual GitHub mode opens canonical source only"); originalOnly.incrementAndGet(); return new Fake(valid); }, NORMAL);
            check(originalOnly.get() == 1 && result.source.id.equals("github"), "Manual route selection does not add relays");

            byte[] old = signed(payload(10301, digest)); AtomicInteger staleCalls = new AtomicInteger();
            result = manifest("auto", 10301, 0, "", 0, new UpdateSourceClient.Session(), null, address -> new Fake(staleCalls.incrementAndGet() == 1 ? old : valid), NORMAL);
            check(staleCalls.get() == 2 && result.release.versionCode == 10302, "Installed-version cached manifest does not hide newer second source");
            AtomicInteger allOld = new AtomicInteger();
            check(failure(() -> manifest("auto", 10301, 10302, digest, APK.length, new UpdateSourceClient.Session(), null, address -> { allOld.incrementAndGet(); return new Fake(old); }, NORMAL)).getMessage().contains("尚未同步"), "All stale signed sources do not report up to date");
            check(allOld.get() == 3, "All configured sources tried for stale mirrors");
            result = manifest("auto", 10302, 10302, digest, APK.length, new UpdateSourceClient.Session(), null, address -> new Fake(valid), NORMAL);
            check(result.release.versionCode == 10302, "Equal installed version remains a fully verified result");
            byte[] divergent = signed(payload(10302, "c".repeat(64))); AtomicInteger divergentCalls = new AtomicInteger();
            check(failure(() -> manifest("auto", 10302, 0, "", 0, new UpdateSourceClient.Session(), null, address -> new Fake(divergentCalls.incrementAndGet() == 1 ? valid : divergent), NORMAL)) instanceof UpdatePolicy.IntegrityException, "Same-version disagreement inside one check fails closed without saved pin");
            check(divergentCalls.get() == 2, "Artifact disagreement stops before third source");

            JSONObject badEnvelope = new JSONObject(new String(valid, StandardCharsets.UTF_8)); badEnvelope.put("signature", Base64.getEncoder().encodeToString(new byte[256])); byte[] invalidSignature = badEnvelope.toString().getBytes(StandardCharsets.UTF_8);
            AtomicInteger signatureCalls = new AtomicInteger();
            check(failure(() -> manifest("auto", 10301, 0, "", 0, new UpdateSourceClient.Session(), null, address -> { signatureCalls.incrementAndGet(); return new Fake(invalidSignature); }, NORMAL)) instanceof UpdatePolicy.IntegrityException, "Bad signature fails closed");
            check(signatureCalls.get() == 1, "Signature failure does not switch source");
            JSONObject wrongCertificate = payload(10302, digest); wrongCertificate.getJSONObject("android").put("certificateSha256", "a".repeat(64)); byte[] wrongIdentity = signed(wrongCertificate);
            check(failure(() -> manifest("auto", 10301, 0, "", 0, new UpdateSourceClient.Session(), null, address -> new Fake(wrongIdentity), NORMAL)) instanceof UpdatePolicy.IntegrityException, "Signed certificate must match installed app");
            check(failure(() -> manifest("auto", 10301, 10302, "b".repeat(64), APK.length, new UpdateSourceClient.Session(), null, address -> new Fake(valid), NORMAL)) instanceof UpdatePolicy.IntegrityException, "Same code cannot change its pinned hash");

            AtomicInteger cancelledOpens = new AtomicInteger(); UpdateSourceClient.Session cancelled = new UpdateSourceClient.Session();
            UpdateTransport.Listener cancelBetween = new UpdateTransport.Listener() { public void onStage(String text) { if (text.contains("自动切换")) cancelled.cancel(); } public void onProgress(long value) {} };
            check(failure(() -> manifest("auto", 10301, 0, "", 0, cancelled, cancelBetween, address -> { cancelledOpens.incrementAndGet(); Fake fail = new Fake(valid); fail.status = 503; return fail; }, NORMAL)).getMessage().contains("取消"), "Cancellation between routes ends whole check");
            check(cancelledOpens.get() == 1, "Cancellation never starts next route");

            Fake first = new Fake(APK); first.status = 503; AtomicInteger downloadCalls = new AtomicInteger(); Events downloadEvents = new Events();
            File artifact = download(release, directory, "auto", new UpdateSourceClient.Session(), downloadEvents, address -> downloadCalls.incrementAndGet() == 1 ? first : new Fake(APK), NORMAL);
            check(downloadCalls.get() == 2 && Arrays.equals(Files.readAllBytes(artifact.toPath()), APK), "Unavailable first APK source switches to exact second APK");
            check(downloadEvents.progress.get(0) == 0 && downloadEvents.progress.get(downloadEvents.progress.size() - 1) == APK.length, "Per-source byte progress resets and ends at exact size"); artifact.delete();
            byte[] altered = APK.clone(); altered[altered.length - 1] ^= 1; AtomicInteger hashCalls = new AtomicInteger();
            check(failure(() -> download(release, directory, "auto", new UpdateSourceClient.Session(), null, address -> { hashCalls.incrementAndGet(); return new Fake(altered); }, NORMAL)).getMessage().contains("SHA-256"), "APK hash mismatch fails closed");
            check(hashCalls.get() == 1 && directory.list().length == 0, "Hash failure neither switches source nor keeps file");
            Fake truncated = new Fake(APK); truncated.input = new ByteArrayInputStream(Arrays.copyOf(APK, APK.length - 1)); AtomicInteger truncatedCalls = new AtomicInteger();
            File resumed = download(release, directory, "auto", new UpdateSourceClient.Session(), null, address -> truncatedCalls.incrementAndGet() == 1 ? truncated : new Fake(APK), NORMAL);
            check(truncatedCalls.get() == 2 && Arrays.equals(Files.readAllBytes(resumed.toPath()), APK), "Incomplete transport restarts on next source then verifies full hash"); resumed.delete();
            UpdateSourceClient.Session stopDownload = new UpdateSourceClient.Session(); AtomicInteger stopCalls = new AtomicInteger();
            UpdateTransport.Listener stopBetween = new UpdateTransport.Listener() { public void onStage(String text) { if (text.contains("自动切换")) stopDownload.cancel(); } public void onProgress(long value) {} };
            check(failure(() -> download(release, directory, "auto", stopDownload, stopBetween, address -> { stopCalls.incrementAndGet(); Fake fail = new Fake(APK); fail.status = 503; return fail; }, NORMAL)).getMessage().contains("取消"), "Cancellation between APK routes stops fallback");
            check(stopCalls.get() == 1 && directory.list().length == 0, "Cancel between APK routes leaves no file/second request");
            AtomicInteger unavailable = new AtomicInteger();
            check(failure(() -> download(release, directory, "auto", new UpdateSourceClient.Session(), null, address -> { unavailable.incrementAndGet(); Fake fail = new Fake(APK); fail.status = 503; return fail; }, NORMAL)).getMessage().contains("均未完成"), "All unavailable sources produce a retryable user result");
            check(unavailable.get() == 3 && directory.list().length == 0, "All unavailable source attempts remain bounded and clean");
            Fake foreign = new Fake(APK); foreign.status = 302; foreign.location = "https://untrusted.invalid/sensitive-query.apk";
            check(failure(() -> download(release, directory, "auto", new UpdateSourceClient.Session(), null, address -> foreign, NORMAL)) instanceof UpdatePolicy.IntegrityException, "Unregistered redirect fails closed");

            // A source's DNS/headers may ignore interruption. The shared deadline
            // permits two bounded attempts, never a fresh full budget per source.
            Gate one = new Gate(), two = new Gate(); Fake stuckOne = new Fake(valid), stuckTwo = new Fake(valid); stuckOne.headers = one; stuckTwo.headers = two;
            AtomicInteger deadlineCalls = new AtomicInteger(); long start = System.nanoTime();
            Async deadline = new Async(() -> manifest("auto", 10301, 0, "", 0, new UpdateSourceClient.Session(), null, address -> deadlineCalls.incrementAndGet() == 1 ? stuckOne : stuckTwo, new UpdateSourceClient.Timing(180, 180, 110, 5)));
            try { one.await(); two.await(); deadline.failed("超时"); check(deadlineCalls.get() == 2, "Shared deadline prevents a third reset budget"); check(System.nanoTime() - start < TimeUnit.MILLISECONDS.toNanos(900), "Whole operation deadline stays bounded"); }
            finally { one.open(); two.open(); }
            until(() -> stuckOne.closed.get() >= 2 && stuckTwo.closed.get() >= 2, "Abandoned header tasks finish cleanup"); Thread.sleep(20);

            // First source writes a byte then stalls; its late data cannot alter
            // the second attempt's file or publish stale byte progress.
            Gate lateRead = new Gate(); Fake stalled = new Fake(APK); stalled.input = new InputStream() {
                int state;
                public int read() { throw new AssertionError("Bulk reads expected"); }
                public int read(byte[] buffer, int off, int len) { if (state++ == 0) { buffer[off] = APK[0]; return 1; } if (state == 2) { lateRead.block(); System.arraycopy(APK, 1, buffer, off, APK.length - 1); return APK.length - 1; } return -1; }
            };
            AtomicInteger isolatedCalls = new AtomicInteger(); Events isolatedEvents = new Events();
            File successful;
            try { successful = download(release, directory, "auto", new UpdateSourceClient.Session(), isolatedEvents, address -> isolatedCalls.incrementAndGet() == 1 ? stalled : new Fake(APK), QUICK); }
            finally { lateRead.open(); }
            until(() -> stalled.closed.get() >= 2, "Late partial read unwinds its own connection"); Thread.sleep(20);
            check(isolatedCalls.get() == 2 && Arrays.equals(Files.readAllBytes(successful.toPath()), APK), "Late abandoned attempt cannot corrupt new artifact");
            check(directory.list().length == 1 && isolatedEvents.progress.get(isolatedEvents.progress.size() - 1) == APK.length, "Only successful unique file and progress remain"); successful.delete();

            Fake trickle = new Fake(APK); trickle.input = new InputStream() { int index; public int read() { throw new AssertionError("Bulk reads expected"); } public int read(byte[] buffer, int off, int len) { if (index == APK.length) return -1; try { Thread.sleep(50); } catch (InterruptedException ignored) {} buffer[off] = APK[index++]; return 1; } };
            AtomicInteger trickleCalls = new AtomicInteger();
            check(failure(() -> download(release, directory, "auto", new UpdateSourceClient.Session(), null, address -> { trickleCalls.incrementAndGet(); return trickle; }, new UpdateSourceClient.Timing(300, 180, 110, 5))).getMessage().contains("超时"), "Continuous APK progress cannot extend whole download deadline");
            until(() -> trickle.closed.get() >= 2, "Expired trickle exits its connection");
            check(trickleCalls.get() == 1 && directory.list().length == 0, "Whole deadline does not start a new source budget");

            UpdateSourceClient.Session precancelled = new UpdateSourceClient.Session(); precancelled.cancel(); AtomicInteger preOpens = new AtomicInteger();
            check(failure(() -> download(release, directory, "auto", precancelled, null, address -> { preOpens.incrementAndGet(); return new Fake(APK); }, NORMAL)).getMessage().contains("取消"), "Pre-cancelled session never downloads");
            check(preOpens.get() == 0 && directory.list().length == 0, "No connection/file for cancelled session");
            System.out.println("UpdateSourceClient: " + checks + " checks passed (fake HTTPS only; no network or Android runtime)");
        } finally { File[] files = directory.listFiles(); if (files != null) for (File file : files) file.delete(); directory.delete(); }
    }
}
