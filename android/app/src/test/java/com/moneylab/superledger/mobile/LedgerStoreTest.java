package com.moneylab.superledger.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

/** Host regression tests using explicit test-only Context/AtomicFile adapters. */
public final class LedgerStoreTest {
    private static int checks;
    private static void check(boolean condition, String label) { checks++; if (!condition) throw new AssertionError(label); }
    private static LedgerStore fresh(File directory) throws Exception { Field field = LedgerStore.class.getDeclaredField("instance"); field.setAccessible(true); field.set(null, null); return LedgerStore.get(new Context(directory)); }
    private static JSONObject tx(String id, long amount) throws Exception { return new JSONObject().put("id", id).put("type", "expense").put("amount", amount).put("accountId", "bank").put("category", "其他支出").put("title", "测试账单").put("date", LedgerStore.today()).put("note", "").put("currency", "CNY"); }
    private static JSONObject state(JSONArray transactions) throws Exception { return new JSONObject().put("accounts", new JSONArray().put(new JSONObject().put("id", "bank").put("name", "测试银行").put("currency", "CNY").put("openingBalance", 10000))).put("transactions", transactions); }
    private static JSONObject response(JSONObject request, JSONObject state, JSONArray accepted, JSONArray conflicts) throws Exception { return new JSONObject().put("requestId", request.getString("requestId")).put("bookId", "book_test").put("state", state).put("accepted", accepted).put("conflicts", conflicts).put("summary", new JSONObject()); }
    private static void pair(LedgerStore store, JSONArray transactions) throws Exception { JSONObject request = store.syncRequest(UUID.randomUUID().toString()); store.applyResponse(response(request, state(transactions), new JSONArray(), new JSONArray()), request); }
    public static void main(String[] args) throws Exception {
        File workspace = Files.createTempDirectory("superledger-store-tests-").toFile();
        LedgerStore store = fresh(new File(workspace, "delete")); pair(store, new JSONArray());
        JSONObject created = tx("mobile_new", 2800); store.putTransaction(created, null);
        JSONObject unacknowledged = store.syncRequest(UUID.randomUUID().toString());
        check(unacknowledged.getJSONArray("operations").getJSONObject(0).isNull("base"), "new put initially has null base");
        // The computer may have persisted this put, even though no acknowledgement arrived.
        store.deleteTransaction("mobile_new"); JSONObject deletion = store.syncRequest(UUID.randomUUID().toString()); JSONObject op = deletion.getJSONArray("operations").getJSONObject(0);
        check(op.getString("kind").equals("delete") && op.getJSONObject("base").getLong("amount") == 2800, "lost ACK then delete retains a tombstone with complete base");
        store.applyResponse(response(deletion, state(new JSONArray()), new JSONArray().put(op.getString("id")), new JSONArray()), deletion);
        check(store.snapshot().getJSONArray("operations").length() == 0 && store.snapshot().getJSONObject("state").getJSONArray("transactions").length() == 0, "acknowledged delete does not resurrect mobile transaction");

        store = fresh(new File(workspace, "conflict")); JSONObject computer = tx("shared", 1000); pair(store, new JSONArray().put(computer));
        JSONObject edit = LedgerStore.copy(computer).put("amount", 1200); store.putTransaction(edit, null); JSONObject request = store.syncRequest(UUID.randomUUID().toString()); String operationId = request.getJSONArray("operations").getJSONObject(0).getString("id");
        JSONObject current = LedgerStore.copy(computer).put("amount", 1300); JSONArray conflicts = new JSONArray().put(new JSONObject().put("operationId", operationId).put("reason", "电脑已修改").put("current", current));
        store.applyResponse(response(request, state(new JSONArray().put(current)), new JSONArray(), conflicts), request);
        JSONObject skipped = store.syncRequest(UUID.randomUUID().toString()); check(skipped.getJSONArray("operations").length() == 0, "known conflicts are not blindly resubmitted");
        JSONObject newest = LedgerStore.copy(computer).put("amount", 1500); store.applyResponse(response(skipped, state(new JSONArray().put(newest)), new JSONArray(), new JSONArray()), skipped);
        check(store.snapshot().getJSONArray("conflicts").length() == 1 && store.snapshot().getJSONArray("conflicts").getJSONObject(0).getJSONObject("current").getLong("amount") == 1500, "download-only sync retains conflict and refreshes current version");
        store.resolveConflict(operationId, false); check(store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0).getLong("amount") == 1500, "adopting computer uses newest version");

        store = fresh(new File(workspace, "capture")); pair(store, new JSONArray()); store.setCapture(true); store.setSource("cmb.pb", "招商银行", true, "bank"); store.startSync();
        store.capture("cmb.pb", "notification-test", System.currentTimeMillis(), PaymentParser.parse("cmb.pb", "交易通知", "消费人民币28.00元"));
        store.endSync(); check(store.snapshot().getJSONArray("pending").length() == 1, "capture arriving during sync is durably queued for review");

        store = fresh(new File(workspace, "batch")); pair(store, new JSONArray()); Field dataField = LedgerStore.class.getDeclaredField("data"); dataField.setAccessible(true); JSONObject fixture = (JSONObject) dataField.get(store); JSONArray operations = fixture.getJSONArray("operations"); StringBuilder longNote = new StringBuilder(); for (int i = 0; i < 2000; i++) longNote.append('账');
        for (int i = 0; i < 501; i++) { JSONObject value = tx("batch_" + i, 100).put("note", longNote.toString()); operations.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("kind", "put").put("base", LedgerStore.copy(value)).put("transaction", value)); }
        JSONObject batch = store.syncRequest(UUID.randomUUID().toString()); check(batch.getJSONArray("operations").length() > 0 && batch.getJSONArray("operations").length() < 500, "UTF8 size limit batches large edits before count limit"); check(batch.toString().getBytes(StandardCharsets.UTF_8).length <= 2 * 1024 * 1024, "plaintext request remains within 2 MiB");

        store = fresh(new File(workspace, "recover")); pair(store, new JSONArray().put(tx("old", 1000))); store.deleteTransaction("old"); store.putTransaction(tx("new", 2000), null); store.archiveForReconnect(); JSONObject recovered = store.snapshot();
        check(recovered.isNull("bookId") && recovered.getJSONArray("operations").length() == 0, "recovery disconnects old queue from new book");
        check(recovered.getJSONArray("archives").getJSONObject(0).getJSONArray("operations").length() == 2, "old puts and deletes retained in archive");
        check(recovered.getJSONArray("pending").length() == 1 && recovered.getJSONArray("pending").getJSONObject(0).getJSONObject("transaction").getString("accountId").isEmpty(), "old put needs explicit account review");

        File recoveryDir = new File(workspace, "atomic"); store = fresh(recoveryDir); pair(store, new JSONArray().put(tx("persisted", 8800))); File original = new File(recoveryDir, "mobile-ledger.json"), backup = new File(recoveryDir, "mobile-ledger.json.bak"); Files.move(original.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING); store = fresh(recoveryDir);
        check(store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0).getLong("amount") == 8800, "backup-only AtomicFile state is recovered rather than reset");
        System.out.println("LedgerStore: " + checks + " checks passed (host adapters, not Android runtime)");
    }
}
