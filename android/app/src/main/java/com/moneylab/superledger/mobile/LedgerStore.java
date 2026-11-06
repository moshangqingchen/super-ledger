package com.moneylab.superledger.mobile;

import android.content.Context;
import android.os.Build;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** Every change is persisted atomically before it is displayed or acknowledged. */
public final class LedgerStore {
    private static LedgerStore instance;
    private final AtomicFile file;
    private JSONObject data;
    private boolean syncing;
    private String captureError = "";
    public static final String[][] SOURCES = {
        {"com.tencent.mm", "微信支付"}, {"com.eg.android.AlipayGphone", "支付宝"},
        {"com.icbc", "工商银行"}, {"com.chinamworld.main", "建设银行"},
        {"com.android.bankabc", "农业银行"}, {"cmb.pb", "招商银行"},
        {"com.chinamworld.bocmbci", "中国银行"}, {"com.bankcomm.Bankcomm", "交通银行"},
        {"com.yitong.mbank.psbc", "邮储银行"}, {"com.pingan.paces.ccms", "平安口袋银行"},
        {"com.unionpay", "云闪付"}
    };
    public static synchronized LedgerStore get(Context context) throws Exception {
        if (instance == null) instance = new LedgerStore(context.getApplicationContext());
        return instance;
    }
    private LedgerStore(Context context) throws Exception {
        file = new AtomicFile(new File(context.getFilesDir(), "mobile-ledger.json"));
        if (file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists()) {
            try (FileInputStream in = file.openRead()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
                while ((count = in.read(buffer)) >= 0) { out.write(buffer, 0, count); if (out.size() > 16 * 1024 * 1024) throw new Exception("手机账本超过读取上限，原文件已保留"); }
                data = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                if (data.optInt("version") != 1 || data.optJSONArray("operations") == null || data.optJSONObject("state") == null) throw new Exception("手机账本格式无效，原文件已保留");
            }
        } else {
            data = new JSONObject().put("version", 1).put("deviceId", UUID.randomUUID().toString()).put("bookId", JSONObject.NULL)
                .put("state", new JSONObject().put("accounts", new JSONArray()).put("transactions", new JSONArray()))
                .put("operations", new JSONArray()).put("pending", new JSONArray()).put("conflicts", new JSONArray())
                .put("seen", new JSONArray()).put("sources", new JSONObject()).put("mappings", new JSONObject()).put("captureEnabled", false);
            for (String[] source : SOURCES) data.getJSONObject("sources").put(source[0], new JSONObject().put("name", source[1]).put("enabled", true));
            persist();
        }
    }
    private void persist() throws Exception {
        byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 16 * 1024 * 1024) throw new Exception("手机存储达到容量限制，请先同步并清理待确认通知");
        FileOutputStream output = null;
        try { output = file.startWrite(); output.write(bytes); file.finishWrite(output); }
        catch (Exception e) { if (output != null) file.failWrite(output); throw e; }
    }
    private interface Mutation { void run() throws Exception; }
    private void change(Mutation work) throws Exception {
        JSONObject backup = copy(data);
        try { work.run(); persist(); } catch (Exception e) { data = backup; throw e; }
    }
    public static JSONObject copy(JSONObject input) throws Exception { return new JSONObject(input.toString()); }
    public static JSONArray copyArray(JSONArray input) throws Exception { return new JSONArray(input.toString()); }
    public synchronized JSONObject snapshot() throws Exception { return copy(data).put("captureError", captureError); }
    public synchronized void captureFailed() { captureError = "付款通知保存失败，请检查手机可用存储并重新打开应用。已有账本保留，失败的通知可能需要手动补记。"; }
    public synchronized boolean isSyncing() { return syncing; }
    public synchronized void startSync() throws Exception { if (syncing) throw new Exception("正在同步，请稍候"); syncing = true; }
    public synchronized void endSync() { syncing = false; }
    public synchronized boolean sourceEnabled(String pkg) { JSONObject entry = data.optJSONObject("sources").optJSONObject(pkg); return data.optBoolean("captureEnabled") && entry != null && entry.optBoolean("enabled"); }
    public synchronized void setCapture(boolean enabled) throws Exception { change(() -> data.put("captureEnabled", enabled)); }
    public synchronized void setSource(String pkg, String label, boolean enabled, String accountId) throws Exception {
        if (!pkg.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")) throw new Exception("应用包名格式不正确");
        change(() -> {
            data.getJSONObject("sources").put(pkg, new JSONObject().put("name", label).put("enabled", enabled));
            if (accountId == null || accountId.isEmpty()) data.getJSONObject("mappings").remove(pkg);
            else data.getJSONObject("mappings").put(pkg, accountId);
        });
    }
    public static String today() { return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date()); }
    public static String date(long millis) { return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(millis)); }
    public static String hash(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.US, "%02x", b)); return result.toString();
    }
    private static JSONObject find(JSONArray array, String id) {
        for (int i = 0; i < array.length(); i++) { JSONObject item = array.optJSONObject(i); if (item != null && id.equals(item.optString("id"))) return item; } return null;
    }
    private static int findIndex(JSONArray array, String id) { for (int i = 0; i < array.length(); i++) if (id.equals(array.optJSONObject(i).optString("id"))) return i; return -1; }
    private static String txId(JSONObject operation) { return operation.optString("kind").equals("delete") ? operation.optString("transactionId") : operation.optJSONObject("transaction").optString("id"); }
    private void requireIdle() throws Exception { if (syncing) throw new Exception("正在同步，请完成后再修改账单"); }
    private void requireBook() throws Exception { if (data.isNull("bookId") || data.optString("bookId").isEmpty()) throw new Exception("请先扫码连接电脑，取得账户后再记账"); }
    private void queuePut(JSONObject tx) throws Exception {
        JSONArray transactions = data.getJSONObject("state").getJSONArray("transactions"), operations = data.getJSONArray("operations");
        JSONObject existing = find(transactions, tx.getString("id")); Object base = existing == null ? JSONObject.NULL : copy(existing);
        for (int i = operations.length() - 1; i >= 0; i--) if (tx.getString("id").equals(txId(operations.getJSONObject(i)))) { base = operations.getJSONObject(i).opt("base"); operations.remove(i); }
        JSONObject op = new JSONObject().put("id", UUID.randomUUID().toString()).put("kind", "put").put("base", base == null ? JSONObject.NULL : base).put("transaction", copy(tx)).put("allowDuplicate", false);
        operations.put(op); int index = findIndex(transactions, tx.getString("id")); if (index < 0) transactions.put(copy(tx)); else transactions.put(index, copy(tx));
    }
    public synchronized void putTransaction(JSONObject tx, String pendingId) throws Exception {
        requireIdle(); requireBook(); validateTransaction(tx);
        change(() -> { queuePut(tx); if (pendingId != null) { int idx = findIndex(data.getJSONArray("pending"), pendingId); if (idx >= 0) data.getJSONArray("pending").remove(idx); } });
    }
    private void validateTransaction(JSONObject tx) throws Exception {
        if (!tx.optString("id").matches("[A-Za-z0-9_-]{1,128}")) throw new Exception("账单 ID 无效");
        if (!tx.optString("type").equals("income") && !tx.optString("type").equals("expense")) throw new Exception("手机版暂支持收入和支出记账");
        if (tx.optLong("amount") <= 0 || tx.optLong("amount") > 1_000_000_000_000L) throw new Exception("请输入有效金额");
        JSONObject account = find(data.getJSONObject("state").getJSONArray("accounts"), tx.optString("accountId"));
        if (account == null || !account.optString("currency", "CNY").equals("CNY")) throw new Exception("请选择人民币账户");
        if (tx.optString("title").trim().isEmpty() || tx.optString("title").length() > 120) throw new Exception("账单名称须为 1 至 120 字");
        if (tx.optString("category").trim().isEmpty() || tx.optString("category").length() > 50) throw new Exception("请填写分类（最多 50 字）");
        if (tx.optString("note").length() > 2000) throw new Exception("备注最多 2000 字");
        SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd", Locale.US); date.setLenient(false);
        if (!tx.optString("date").matches("(?:19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}")) throw new Exception("日期格式为 YYYY-MM-DD");
        date.parse(tx.getString("date")); if (tx.getString("date").compareTo(today()) > 0) throw new Exception("账单日期不能晚于今天");
    }
    public synchronized void deleteTransaction(String id) throws Exception {
        requireIdle(); requireBook();
        change(() -> {
            JSONArray transactions = data.getJSONObject("state").getJSONArray("transactions"), ops = data.getJSONArray("operations");
            JSONObject old = find(transactions, id); if (old == null) return; Object base = copy(old);
            for (int i = ops.length() - 1; i >= 0; i--) if (id.equals(txId(ops.getJSONObject(i)))) { base = ops.getJSONObject(i).opt("base"); ops.remove(i); }
            // A lost acknowledgement may mean a base=null put already exists on the computer.
            // Keep a tombstone even for an apparently unsynced creation, so it cannot reappear.
            if (base == null || base == JSONObject.NULL) base = copy(old);
            ops.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("kind", "delete").put("base", base).put("transactionId", id));
            int idx = findIndex(transactions, id); if (idx >= 0) transactions.remove(idx);
        });
    }
    public synchronized void dismissPending(String id) throws Exception { requireIdle(); change(() -> { int idx = findIndex(data.getJSONArray("pending"), id); if (idx >= 0) data.getJSONArray("pending").remove(idx); }); }
    public synchronized void capture(String pkg, String notificationKey, long postedAt, PaymentParser.Parsed parsed) throws Exception {
        if (!sourceEnabled(pkg)) return;
        String sourceKey = hash(pkg + "|" + (parsed.reference.isEmpty() ? notificationKey + "|" + postedAt + "|" + parsed.snippet : "reference:" + parsed.reference));
        JSONArray seen = data.getJSONArray("seen"); for (int i = 0; i < seen.length(); i++) if (sourceKey.equals(seen.optString(i))) return;
        change(() -> {
            JSONArray seenList = data.getJSONArray("seen"); seenList.put(sourceKey); while (seenList.length() > 8000) seenList.remove(0);
            JSONObject capture = new JSONObject().put("sourcePackage", pkg).put("sourceKey", sourceKey).put("occurredAt", postedAt);
            if (!parsed.reference.isEmpty()) capture.put("reference", parsed.reference); if (!parsed.merchant.isEmpty()) capture.put("merchant", parsed.merchant);
            String accountId = resolveAccount(pkg, parsed.lastFour);
            JSONObject tx = new JSONObject().put("id", "mob_" + UUID.randomUUID()).put("type", parsed.type).put("amount", parsed.amount)
                .put("accountId", accountId).put("category", parsed.category).put("title", parsed.title).put("date", date(postedAt)).put("note", "手机付款通知识别").put("currency", "CNY").put("mobileCapture", capture);
            String reason = parsed.reason;
            if (accountId.isEmpty()) reason = "尚未确定扣款账户，请核对后入账";
            else if (data.isNull("bookId")) reason = "请先扫码连接电脑取得账本";
            else if (suspectedDuplicate(tx)) reason = "已有同金额、同日的相关交易，请核对是否重复或订阅扣款";
            if (parsed.confident && reason.isEmpty() && !syncing) queuePut(tx);
            else {
                if (reason.isEmpty()) reason = "同步期间收到付款通知，请确认后入账";
                if (data.getJSONArray("pending").length() >= 3000) throw new Exception("待确认列表已满，请处理后继续采集");
                data.getJSONArray("pending").put(new JSONObject().put("id", UUID.randomUUID().toString()).put("transaction", tx).put("reason", reason).put("snippet", parsed.snippet).put("sourcePackage", pkg));
            }
            data.put("lastCaptureAt", System.currentTimeMillis());
        });
        captureError = "";
    }
    private String resolveAccount(String pkg, String lastFour) throws Exception {
        JSONArray accounts = data.getJSONObject("state").getJSONArray("accounts");
        if (!lastFour.isEmpty()) {
            String match = ""; int count = 0;
            for (int i = 0; i < accounts.length(); i++) { JSONObject a = accounts.getJSONObject(i); if (lastFour.equals(a.optString("lastFour")) && a.optString("currency", "CNY").equals("CNY")) { match = a.getString("id"); count++; } }
            return count == 1 ? match : "";
        }
        String mapped = data.getJSONObject("mappings").optString(pkg); JSONObject a = find(accounts, mapped);
        // No implicit “WeChat = wallet” assumption: users often pay with a bank card.
        return a != null && a.optString("currency", "CNY").equals("CNY") ? mapped : "";
    }
    private boolean suspectedDuplicate(JSONObject tx) throws Exception {
        JSONArray transactions = data.getJSONObject("state").getJSONArray("transactions");
        for (int i = 0; i < transactions.length(); i++) {
            JSONObject old = transactions.getJSONObject(i);
            if (!old.optString("date").equals(tx.optString("date")) || old.optLong("amount") != tx.optLong("amount") || !old.optString("type").equals(tx.optString("type"))) continue;
            if (old.has("subscriptionId") && old.optString("accountId").equals(tx.optString("accountId"))) return true;
            JSONObject capture = old.optJSONObject("mobileCapture");
            if (capture != null && Math.abs(capture.optLong("occurredAt") - tx.getJSONObject("mobileCapture").optLong("occurredAt")) <= 5 * 60 * 1000) {
                JSONObject incoming = tx.getJSONObject("mobileCapture");
                // Separate references from the same provider identify separate payments.
                // Without that evidence, notification updates also need duplicate review.
                boolean distinctReferences = capture.optString("sourcePackage").equals(incoming.optString("sourcePackage")) && !capture.optString("reference").isEmpty() && !incoming.optString("reference").isEmpty() && !capture.optString("reference").equals(incoming.optString("reference"));
                if (!distinctReferences) return true;
            }
        } return false;
    }
    public synchronized JSONObject syncRequest(String requestId) throws Exception {
        Set<String> unresolved = new HashSet<>(); JSONArray conflicts = data.getJSONArray("conflicts");
        for (int i = 0; i < conflicts.length(); i++) unresolved.add(conflicts.getJSONObject(i).optString("operationId"));
        JSONArray selected = new JSONArray(), operations = data.getJSONArray("operations");
        JSONObject request = new JSONObject().put("requestId", requestId).put("deviceId", data.getString("deviceId")).put("deviceName", Build.MANUFACTURER + " " + Build.MODEL)
            .put("bookId", data.opt("bookId")).put("operations", selected);
        int bytes = request.toString().getBytes(StandardCharsets.UTF_8).length;
        for (int i = 0; i < operations.length() && selected.length() < 500; i++) {
            JSONObject operation = operations.getJSONObject(i); if (unresolved.contains(operation.getString("id"))) continue;
            int size = operation.toString().getBytes(StandardCharsets.UTF_8).length + (selected.length() == 0 ? 0 : 1);
            if (bytes + size > 2 * 1024 * 1024) { if (selected.length() == 0) throw new Exception("单条修改超过同步容量上限，请缩短备注后再试"); break; }
            selected.put(copy(operation)); bytes += size;
        }
        return request;
    }
    public synchronized void applyResponse(JSONObject response, JSONObject sentRequest) throws Exception {
        String bookId = response.getString("bookId"); if (bookId.isEmpty()) throw new Exception("电脑未返回有效账本标识");
        if (!data.isNull("bookId") && !data.getString("bookId").equals(bookId)) throw new Exception("这不是此前配对的账本，手机待同步内容已保留");
        if (!response.optString("requestId").equals(sentRequest.optString("requestId"))) throw new Exception("同步响应不匹配，请重新扫码");
        JSONObject state = response.getJSONObject("state"); if (state.optJSONArray("accounts") == null || state.optJSONArray("transactions") == null) throw new Exception("电脑返回的账本格式不正确");
        Set<String> accepted = new HashSet<>(); JSONArray ack = response.optJSONArray("accepted"); if (ack == null) throw new Exception("同步确认列表缺失");
        Set<String> sent = new HashSet<>(); JSONArray sentOps = sentRequest.getJSONArray("operations"); for (int i = 0; i < sentOps.length(); i++) sent.add(sentOps.getJSONObject(i).getString("id"));
        for (int i = 0; i < ack.length(); i++) { String id = ack.getString(i); if (!sent.contains(id)) throw new Exception("电脑返回了未知的同步确认"); accepted.add(id); }
        change(() -> {
            data.put("bookId", bookId).put("state", copy(state));
            JSONArray operations = data.getJSONArray("operations");
            for (int i = operations.length() - 1; i >= 0; i--) if (accepted.contains(operations.getJSONObject(i).getString("id"))) operations.remove(i);
            JSONArray transactions = data.getJSONObject("state").getJSONArray("transactions");
            // Preserve unacknowledged local work while incorporating all desktop changes.
            for (int i = 0; i < operations.length(); i++) {
                JSONObject op = operations.getJSONObject(i); int index = findIndex(transactions, txId(op));
                if (op.getString("kind").equals("delete")) { if (index >= 0) transactions.remove(index); }
                else if (index < 0) transactions.put(copy(op.getJSONObject("transaction"))); else transactions.put(index, copy(op.getJSONObject("transaction")));
            }
            JSONArray mergedConflicts = new JSONArray(), returned = response.optJSONArray("conflicts") == null ? new JSONArray() : response.getJSONArray("conflicts"), previousConflicts = data.getJSONArray("conflicts");
            Set<String> returnedIds = new HashSet<>(); for (int i = 0; i < returned.length(); i++) returnedIds.add(returned.getJSONObject(i).optString("operationId"));
            for (int i = 0; i < previousConflicts.length(); i++) {
                JSONObject conflict = previousConflicts.getJSONObject(i); String id = conflict.optString("operationId"); int operationIndex = findIndex(operations, id);
                if (!accepted.contains(id) && !returnedIds.contains(id) && operationIndex >= 0) {
                    JSONObject latest = copy(conflict), operation = operations.getJSONObject(operationIndex);
                    JSONObject current = find(state.getJSONArray("transactions"), txId(operation)); latest.put("current", current == null ? JSONObject.NULL : copy(current));
                    JSONObject candidate = conflict.optJSONObject("candidate");
                    if (candidate != null) { JSONObject currentCandidate = find(state.getJSONArray("transactions"), candidate.optString("id")); if (currentCandidate == null) latest.remove("candidate"); else latest.put("candidate", copy(currentCandidate)); }
                    mergedConflicts.put(latest);
                }
            }
            for (int i = 0; i < returned.length(); i++) if (findIndex(operations, returned.getJSONObject(i).optString("operationId")) >= 0) mergedConflicts.put(copy(returned.getJSONObject(i)));
            data.put("conflicts", mergedConflicts);
            data.put("lastSyncAt", System.currentTimeMillis()).put("lastSummary", response.optJSONObject("summary") == null ? new JSONObject() : response.getJSONObject("summary"));
        });
    }
    public synchronized void resolveConflict(String operationId, boolean keepPhone) throws Exception {
        requireIdle();
        change(() -> {
            JSONArray operations = data.getJSONArray("operations"), conflicts = data.getJSONArray("conflicts");
            JSONObject conflict = null; int conflictIndex = -1;
            for (int i = 0; i < conflicts.length(); i++) if (operationId.equals(conflicts.getJSONObject(i).optString("operationId"))) { conflict = conflicts.getJSONObject(i); conflictIndex = i; break; }
            int opIndex = findIndex(operations, operationId); if (conflict == null || opIndex < 0) throw new Exception("这条冲突已处理，请刷新");
            JSONObject op = operations.getJSONObject(opIndex), current = conflict.optJSONObject("current");
            JSONArray transactions = data.getJSONObject("state").getJSONArray("transactions"); int txIndex = findIndex(transactions, txId(op));
            if (!keepPhone) {
                operations.remove(opIndex); if (txIndex >= 0) transactions.remove(txIndex); if (current != null) transactions.put(copy(current));
            } else {
                JSONObject revised = copy(op).put("id", UUID.randomUUID().toString()).put("base", current == null ? JSONObject.NULL : copy(current)).put("allowDuplicate", true);
                operations.put(opIndex, revised);
            }
            conflicts.remove(conflictIndex);
        });
    }
    public synchronized void reconnectEmpty() throws Exception {
        requireIdle(); if (data.getJSONArray("operations").length() > 0) throw new Exception("还有未同步修改，请先同步或处理冲突，不能切换账本");
        change(() -> { data.put("bookId", JSONObject.NULL).put("state", new JSONObject().put("accounts", new JSONArray()).put("transactions", new JSONArray())).put("conflicts", new JSONArray()).put("mappings", new JSONObject()); });
    }
    /** Called only after an explicit user export and recovery confirmation. */
    public synchronized void archiveForReconnect() throws Exception {
        requireIdle();
        change(() -> {
            JSONArray operations = data.getJSONArray("operations"), archives = data.optJSONArray("archives"); if (archives == null) archives = new JSONArray();
            archives.put(new JSONObject().put("bookId", data.opt("bookId")).put("archivedAt", System.currentTimeMillis()).put("operations", copyArray(operations)).put("conflicts", copyArray(data.getJSONArray("conflicts")))); data.put("archives", archives);
            JSONArray pending = data.getJSONArray("pending");
            if (pending.length() + operations.length() > 3000) throw new Exception("待确认数量超过上限，请先处理通知或保留完整导出备份后再恢复");
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.getJSONObject(i); if (!operation.optString("kind").equals("put")) continue;
                JSONObject transaction = copy(operation.getJSONObject("transaction")); transaction.put("id", "mob_" + UUID.randomUUID()).put("accountId", ""); transaction.remove("subscriptionId"); transaction.remove("occurrenceKey");
                pending.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("transaction", transaction).put("reason", "从旧账本保留的未同步修改，请核对新账本是否已有此笔，并重新选择账户").put("snippet", "旧操作已存档，只有你确认后才会提交到新账本。").put("sourcePackage", "旧账本"));
            }
            data.put("bookId", JSONObject.NULL).put("state", new JSONObject().put("accounts", new JSONArray()).put("transactions", new JSONArray())).put("operations", new JSONArray()).put("conflicts", new JSONArray()).put("mappings", new JSONObject());
        });
    }
}
