package com.moneylab.superledger.mobile;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;

/** No sockets are created: fake HTTPS connections can deliberately ignore interruption. */
public final class UpdateTransportTest {
    private static final String APK = "https://github.com/" + UpdatePolicy.REPOSITORY + "/releases/download/android-v1.3.1/SuperLedger-Mobile-1.3.1.apk";
    private static final String CDN = "https://release-assets.githubusercontent.com/github-production-release-asset/test?token=private-test-value";
    private static final byte[] BYTES = new byte[]{80, 75, 1, 2, 3, 4};
    private static final UpdateTransport.Limits NORMAL = new UpdateTransport.Limits(2000, 4000, 10);
    private static final UpdateTransport.Limits QUICK = new UpdateTransport.Limits(180, 1500, 10);
    private static int checks;
    private interface Task { void run() throws Exception; }
    private interface Condition { boolean ready() throws Exception; }
    private static void check(boolean value, String description) { if (!value) throw new AssertionError(description); checks++; }
    private static String failure(Task action) throws Exception {
        try { action.run(); throw new AssertionError("Expected a rejected transfer"); }
        catch (AssertionError error) { throw error; }
        catch (Exception error) { check(error.getMessage() != null && !error.getMessage().contains("private-test-value"), "No temporary asset tokens in errors"); return error.getMessage(); }
    }
    private static void integrityFailure(Task action, String label) throws Exception {
        try { action.run(); throw new AssertionError("Expected integrity rejection"); }
        catch (AssertionError error) { throw error; }
        catch (Exception error) {
            check(error instanceof UpdatePolicy.IntegrityException, label);
            check(error.getMessage() != null && !error.getMessage().contains("private-test-value"), "No temporary asset tokens in errors");
        }
    }
    private static void until(Condition condition, String description) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!condition.ready() && System.nanoTime() < end) Thread.sleep(5);
        check(condition.ready(), description);
    }
    private static final class Gate {
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        void blockIgnoringInterrupt() { entered.countDown(); boolean done = false; while (!done) { try { release.await(); done = true; } catch (InterruptedException ignored) {} } }
        void awaitEntered() throws Exception { check(entered.await(2, TimeUnit.SECONDS), "Fake network reached blocking point"); }
        void unblock() { release.countDown(); }
    }
    private static final class Result {
        volatile Throwable error; final Thread caller;
        Result(Task task) { caller = new Thread(() -> { try { task.run(); } catch (Throwable error) { this.error = error; } }, "transport-test-caller"); caller.setDaemon(true); caller.start(); }
        void awaitFailure(String match) throws Exception { caller.join(1000); check(!caller.isAlive(), "Caller returned without waiting for blocked network"); check(error instanceof Exception && error.getMessage().contains(match), "Expected failure: " + match + " but got " + error); }
    }
    private static class Fake extends HttpsURLConnection {
        int status = 200; long length = BYTES.length; String location, encoding; byte[] body = BYTES;
        Gate headers, inputOpen, disconnectGate; InputStream stream;
        final AtomicInteger disconnects = new AtomicInteger();
        Fake() throws Exception { super(new URL(APK)); }
        @Override public int getResponseCode() { if (headers != null) headers.blockIgnoringInterrupt(); return status; }
        @Override public String getHeaderField(String name) { return "Location".equalsIgnoreCase(name) ? location : null; }
        @Override public long getContentLengthLong() { return length; }
        @Override public String getContentEncoding() { return encoding; }
        @Override public InputStream getInputStream() { if (inputOpen != null) inputOpen.blockIgnoringInterrupt(); return stream == null ? new ByteArrayInputStream(body) : stream; }
        @Override public void disconnect() { disconnects.incrementAndGet(); if (disconnectGate != null) disconnectGate.blockIgnoringInterrupt(); }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return "fake"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }
    private static final class Events implements UpdateTransport.Listener {
        final List<String> stages = Collections.synchronizedList(new ArrayList<String>());
        final List<Long> bytes = Collections.synchronizedList(new ArrayList<Long>());
        @Override public void onStage(String value) { stages.add(value); }
        @Override public void onProgress(long value) { bytes.add(value); }
        int count() { return stages.size() + bytes.size(); }
    }
    private static File file(File directory, String name) { return new File(directory, name + ".part.apk"); }
    private static void download(Fake connection, File output, UpdateTransport.Operation operation, Events events, UpdateTransport.Limits limits) throws Exception {
        UpdateTransport.download(APK, BYTES.length, output, operation, events, ignored -> connection, limits);
    }
    public static void main(String[] args) throws Exception {
        File directory = Files.createTempDirectory("ledger-update-transport-").toFile();
        try {
            Fake normal = new Fake(); Events events = new Events(); File output = file(directory, "success");
            download(normal, output, new UpdateTransport.Operation(), events, NORMAL);
            check(Arrays.equals(Files.readAllBytes(output.toPath()), BYTES), "Successful transfer preserves exact bytes");
            check(events.bytes.get(events.bytes.size() - 1) == BYTES.length, "Final progress is exact length");
            check(normal.getConnectTimeout() == 15000 && normal.getReadTimeout() == 20000, "Platform connect/read limits configured");
            check(!normal.getInstanceFollowRedirects() && !normal.getUseCaches(), "No automatic redirects or cached responses");
            check(normal.disconnects.get() > 0, "Successful connection is closed");

            Fake redirect = new Fake(); redirect.status = 302; redirect.location = CDN;
            Fake target = new Fake(); List<String> addresses = new ArrayList<>();
            UpdateTransport.download(APK, BYTES.length, file(directory, "redirect"), new UpdateTransport.Operation(), new Events(), address -> { addresses.add(address); return addresses.size() == 1 ? redirect : target; }, NORMAL);
            check(addresses.equals(Arrays.asList(APK, CDN)), "Only validated GitHub to permitted CDN redirect is opened");
            Fake foreign = new Fake(); foreign.status = 302; foreign.location = "https://untrusted.invalid/file.apk"; AtomicInteger opens = new AtomicInteger();
            integrityFailure(() -> UpdateTransport.download(APK, BYTES.length, file(directory, "foreign"), new UpdateTransport.Operation(), null, address -> { opens.incrementAndGet(); return foreign; }, NORMAL), "Foreign redirect rejected");
            check(opens.get() == 1, "Unapproved redirect is rejected before opening it");
            Fake insecure = new Fake(); insecure.status = 302; insecure.location = "http://github.com/test.apk";
            integrityFailure(() -> download(insecure, file(directory, "insecure"), new UpdateTransport.Operation(), null, NORMAL), "HTTPS downgrade rejected");
            AtomicInteger redirects = new AtomicInteger();
            check(failure(() -> UpdateTransport.download(APK, BYTES.length, file(directory, "redirect-loop"), new UpdateTransport.Operation(), null, address -> { redirects.incrementAndGet(); Fake c = new Fake(); c.status = 302; c.location = CDN; return c; }, NORMAL)).contains("跳转"), "Redirect loop rejected");
            check(redirects.get() == 6, "At most five redirects followed");

            Fake wrongLength = new Fake(); wrongLength.length++;
            check(failure(() -> download(wrongLength, file(directory, "declared"), new UpdateTransport.Operation(), null, NORMAL)).contains("大小"), "Wrong declared size rejected");
            Fake compressed = new Fake(); compressed.encoding = "gzip";
            check(failure(() -> download(compressed, file(directory, "encoded"), new UpdateTransport.Operation(), null, NORMAL)).contains("编码"), "Unexpected content encoding rejected");
            Fake tooLong = new Fake(); tooLong.length = -1; tooLong.body = new byte[BYTES.length + 1]; File longFile = file(directory, "actual-long");
            check(failure(() -> download(tooLong, longFile, new UpdateTransport.Operation(), null, NORMAL)).contains("超过"), "Actual overrun rejected");
            check(!longFile.exists(), "Oversized partial file removed");
            Fake shortBody = new Fake(); shortBody.body = new byte[BYTES.length - 1]; File shortFile = file(directory, "short");
            check(failure(() -> download(shortBody, shortFile, new UpdateTransport.Operation(), null, NORMAL)).contains("不完整"), "Truncated body rejected");
            check(!shortFile.exists(), "Truncated partial removed");
            File existing = file(directory, "existing"); Files.write(existing.toPath(), new byte[]{9});
            check(failure(() -> download(new Fake(), existing, new UpdateTransport.Operation(), null, NORMAL)).contains("已存在"), "Existing temporary paths are not overwritten");
            check(Arrays.equals(Files.readAllBytes(existing.toPath()), new byte[]{9}), "Existing unrelated file preserved");

            // A late DNS result must not create a file or send a second stage/progress update.
            Gate dns = new Gate(); Fake lateDns = new Fake(); Events dnsEvents = new Events(); File dnsFile = file(directory, "dns"); UpdateTransport.Operation dnsOperation = new UpdateTransport.Operation();
            Result dnsResult = new Result(() -> UpdateTransport.download(APK, BYTES.length, dnsFile, dnsOperation, dnsEvents, address -> { dns.blockIgnoringInterrupt(); return lateDns; }, NORMAL));
            try {
                dns.awaitEntered(); dnsOperation.cancel(); dnsResult.awaitFailure("取消"); int eventCount = dnsEvents.count();
                dns.unblock(); until(() -> lateDns.disconnects.get() > 0, "Late DNS connection closed");
                check(dnsEvents.count() == eventCount && !dnsFile.exists(), "Late DNS cannot emit progress or create a partial file");
            } finally { dns.unblock(); }

            // Headers and disconnect can both ignore interruption. Neither may hold the caller busy.
            Fake stalledHeaders = new Fake(); stalledHeaders.headers = new Gate(); stalledHeaders.disconnectGate = new Gate(); File headerFile = file(directory, "headers");
            Result headerResult = new Result(() -> download(stalledHeaders, headerFile, new UpdateTransport.Operation(), new Events(), QUICK));
            try {
                stalledHeaders.headers.awaitEntered(); headerResult.awaitFailure("没有收到数据");
                stalledHeaders.disconnectGate.awaitEntered();
                Fake retry = new Fake(); File retryFile = file(directory, "retry"); download(retry, retryFile, new UpdateTransport.Operation(), new Events(), NORMAL);
                check(Arrays.equals(Files.readAllBytes(retryFile.toPath()), BYTES), "Retry can succeed while one old header request remains blocked");
            } finally { stalledHeaders.headers.unblock(); stalledHeaders.disconnectGate.unblock(); }
            until(() -> stalledHeaders.disconnects.get() >= 2, "Abandoned header task reaches its own cleanup");
            check(!headerFile.exists(), "Abandoned header task leaves no file");

            Fake lateInput = new Fake(); lateInput.inputOpen = new Gate(); File lateInputFile = file(directory, "input-open"); UpdateTransport.Operation inputOperation = new UpdateTransport.Operation(); Events inputEvents = new Events();
            Result inputResult = new Result(() -> download(lateInput, lateInputFile, inputOperation, inputEvents, NORMAL));
            try {
                lateInput.inputOpen.awaitEntered(); inputOperation.cancel(); inputResult.awaitFailure("取消");
                check(!lateInputFile.exists(), "Cancelled input acquisition removes unopened temporary file"); int eventCount = inputEvents.count();
                lateInput.inputOpen.unblock(); until(() -> lateInput.disconnects.get() >= 2, "Late input acquisition reaches cleanup");
                check(!lateInputFile.exists() && inputEvents.count() == eventCount, "Late input acquisition cannot recreate file or emit callbacks");
            } finally { lateInput.inputOpen.unblock(); }

            Gate readGate = new Gate(); Fake stalledRead = new Fake();
            stalledRead.stream = new InputStream() { boolean returned; @Override public int read() { throw new AssertionError("Bulk reads expected"); } @Override public int read(byte[] b, int off, int len) { if (returned) return -1; readGate.blockIgnoringInterrupt(); returned = true; System.arraycopy(BYTES, 0, b, off, BYTES.length); return BYTES.length; } };
            Events readEvents = new Events(); File readFile = file(directory, "read");
            Result readResult = new Result(() -> download(stalledRead, readFile, new UpdateTransport.Operation(), readEvents, QUICK));
            try {
                readGate.awaitEntered(); readResult.awaitFailure("没有收到数据"); int before = readEvents.count();
                readGate.unblock(); until(() -> !readFile.exists(), "Timed-out partial removed after blocked read unwinds");
                check(readEvents.count() == before && readEvents.bytes.isEmpty(), "Late read cannot emit byte progress");
            } finally { readGate.unblock(); }

            // Continuous progress resets idle time but must not reset the overall deadline.
            Fake drip = new Fake(); drip.length = -1; drip.stream = new InputStream() { @Override public int read() { return 0; } @Override public int read(byte[] b, int off, int len) { try { Thread.sleep(40); } catch (InterruptedException ignored) {} b[off] = 1; return 1; } };
            File dripFile = file(directory, "drip");
            check(failure(() -> UpdateTransport.download(APK, 10000, dripFile, new UpdateTransport.Operation(), null, address -> drip, new UpdateTransport.Limits(200, 280, 10))).contains("耗时过长"), "Total deadline terminates a never-ending trickle");
            until(() -> !dripFile.exists(), "Total deadline removes partial");

            Fake manifest = new Fake(); manifest.body = "{}".getBytes("UTF-8"); manifest.length = 2;
            check(Arrays.equals(UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> { check(address.equals(UpdatePolicy.MANIFEST_URL), "Manifest uses only fixed source"); return manifest; }, NORMAL), manifest.body), "Manifest receives exact bytes");
            Fake manifestRedirect = new Fake(); manifestRedirect.status = 302; manifestRedirect.location = CDN;
            check(failure(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> manifestRedirect, NORMAL)).contains("302"), "Manifest redirects are rejected");
            Fake hugeManifest = new Fake(); hugeManifest.length = UpdatePolicy.MAX_MANIFEST_BYTES + 1;
            check(failure(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> hugeManifest, NORMAL)).contains("超过"), "Manifest declared limit enforced");
            Fake overflowingManifest = new Fake(); overflowingManifest.length = -1; overflowingManifest.body = new byte[UpdatePolicy.MAX_MANIFEST_BYTES + 1];
            check(failure(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> overflowingManifest, NORMAL)).contains("超过"), "Manifest stream limit enforced");
            Gate manifestDns = new Gate(); Fake manifestLate = new Fake();
            Result manifestResult = new Result(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> { manifestDns.blockIgnoringInterrupt(); return manifestLate; }, QUICK));
            try { manifestDns.awaitEntered(); manifestResult.awaitFailure("没有收到数据"); }
            finally { manifestDns.unblock(); }
            until(() -> manifestLate.disconnects.get() > 0, "Late manifest DNS connection closed");

            // Both stuck slots remain bounded, and a third attempt is rejected promptly instead of queued.
            Gate firstGate = new Gate(), secondGate = new Gate(); Fake firstLate = new Fake(), secondLate = new Fake();
            Result firstResult = new Result(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> { firstGate.blockIgnoringInterrupt(); return firstLate; }, QUICK));
            firstGate.awaitEntered(); firstResult.awaitFailure("没有收到数据");
            Result secondResult = new Result(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> { secondGate.blockIgnoringInterrupt(); return secondLate; }, QUICK));
            try {
                secondGate.awaitEntered(); secondResult.awaitFailure("没有收到数据"); AtomicInteger thirdOpened = new AtomicInteger();
                check(failure(() -> UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> { thirdOpened.incrementAndGet(); return new Fake(); }, NORMAL)).contains("仍在释放"), "Saturated bounded pool rejects immediately");
                check(thirdOpened.get() == 0, "No third blocked socket task is created or queued");
            } finally { firstGate.unblock(); secondGate.unblock(); }
            until(() -> firstLate.disconnects.get() > 0 && secondLate.disconnects.get() > 0, "Bounded abandoned tasks clean up after release");
            until(() -> {
                try {
                    Fake recovered = new Fake(); recovered.body = new byte[]{1}; recovered.length = 1;
                    return UpdateTransport.fetchManifest(new UpdateTransport.Operation(), address -> recovered, NORMAL).length == 1;
                } catch (Exception error) { if (error.getMessage().contains("仍在释放")) return false; throw error; }
            }, "Bounded pool accepts normal requests again after abandoned calls finish");
            System.out.println("UpdateTransport: " + checks + " checks passed (fake HTTPS only; no network or Android runtime)");
        } finally {
            File[] files = directory.listFiles(); if (files != null) for (File file : files) file.delete(); directory.delete();
        }
    }
}
