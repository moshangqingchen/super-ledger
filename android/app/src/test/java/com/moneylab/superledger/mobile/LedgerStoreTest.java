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
    private static JSONObject state(JSONArray transactions) throws Exception { return MobileLedger.emptyState().put("accounts", new JSONArray().put(MobileLedgerTest.account("bank","CNY",10000,null))).put("transactions", transactions); }
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

        store=fresh(new File(workspace,"full-mobile"));check(!store.snapshot().optBoolean("screenCaptureEnabled"),"screen assist starts disabled");
        store.saveAccount(MobileLedgerTest.account("usd","USD",10000,"7.2").put("futureMetadata",new JSONObject().put("retained",true)));
        store.saveAccount(new JSONObject().put("id","usd").put("name","美元账户"));
        check(store.snapshot().isNull("bookId")&&store.snapshot().getJSONObject("state").getJSONArray("accounts").getJSONObject(0).getJSONObject("futureMetadata").getBoolean("retained"),"offline account editing before pairing preserves unknown fields");
        store.saveManual(MobileLedgerTest.tx("foreign","expense","usd",1250,LedgerStore.today()));
        JSONObject fx=store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0);
        check(fx.getString("currency").equals("USD")&&fx.getString("cnyRate").equals("7.2"),"manual foreign transaction records rate snapshot");
        store.saveAccount(new JSONObject().put("id","usd").put("cnyRate","8"));
        check(store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0).getString("cnyRate").equals("7.2"),"account repricing does not reprice saved spending");
        String before=store.snapshot().toString();try{store.saveAccount(new JSONObject().put("id","usd").put("currency","CNY"));throw new AssertionError("changed currency with history");}catch(AssertionError e){throw e;}catch(Exception expected){}
        check(before.equals(store.snapshot().toString()),"invalid entity edit rolls state and queue back atomically");
        store.saveAccount(MobileLedgerTest.account("bank","CNY",50000,null));
        store.saveManual(MobileLedgerTest.tx("transfer","transfer","bank",7200,LedgerStore.today()).put("toAccountId","usd").put("toAmount",1000));
        check(MobileLedger.balances(store.snapshot().getJSONObject("state"),LedgerStore.today()).getLong("usd")==9750,"offline transfer updates both balances");
        store.saveGoal(new JSONObject().put("id","trip").put("name","旅行").put("target",100000).put("saved",12345));store.saveSettings(new JSONObject().put("monthlyBudget",300000));
        JSONObject subscription=MobileLedgerTest.subscription("music","bank",1500,LedgerStore.today(),true);store.saveSubscription(subscription);
        JSONObject mobile=store.snapshot();check(mobile.getJSONObject("state").getJSONArray("subscriptions").getJSONObject(0).getJSONArray("processedOccurrences").length()==1,"saving subscription records current occurrence");
        int records=mobile.getJSONObject("state").getJSONArray("transactions").length();store.applyRecurring();check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==records,"store recurrence never double books");
        JSONArray fullOps=store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations");int subscriptionIndex=-1,autoIndex=-1;for(int i=0;i<fullOps.length();i++){JSONObject entry=fullOps.getJSONObject(i);if(entry.optString("entity").equals("subscription"))subscriptionIndex=i;if(entry.optString("entity").equals("transaction")&&entry.getJSONObject("transaction").has("occurrenceKey"))autoIndex=i;}
        check(subscriptionIndex>=0&&autoIndex>subscriptionIndex,"subscription and processed history queued before dependent auto transaction");
        check(store.syncRequest(UUID.randomUUID().toString()).getInt("protocolVersion")==2,"generic entity queue declares protocol 2");
        JSONObject firstAccount=fullOps.getJSONObject(0);check(firstAccount.isNull("base")&&firstAccount.getJSONObject("record").getString("name").equals("美元账户"),"repeated account edits retain earliest null base and queue position");
        store.deleteSubscription("music");JSONArray detached=store.snapshot().getJSONObject("state").getJSONArray("transactions");for(int i=0;i<detached.length();i++)check(!detached.getJSONObject(i).has("subscriptionId"),"subscription deletion keeps expenses without dangling link");
        for(int i=0;i<store.snapshot().getJSONArray("operations").length();i++){JSONObject entry=store.snapshot().getJSONArray("operations").getJSONObject(i);if(entry.optString("entity").equals("transaction")&&entry.optString("kind").equals("put"))check(!entry.getJSONObject("transaction").has("subscriptionId"),"pending transaction put detached with deleted subscription");}
        before=store.snapshot().toString();try{store.deleteAccount("usd");throw new AssertionError("deleted referenced account");}catch(AssertionError e){throw e;}catch(Exception expected){}check(before.equals(store.snapshot().toString()),"deleting referenced account preserves all work");
        JSONObject backupSnapshot=store.snapshot();store.saveGoal(new JSONObject().put("id","other").put("name","新目标").put("target",88800));store.restoreBackup(backupSnapshot);
        JSONObject imported=store.snapshot();check(imported.getJSONObject("state").getJSONArray("goals").length()==1&&imported.getJSONArray("operations").length()==backupSnapshot.getJSONArray("operations").length(),"mobile restore retains complete state and pending sync queue");
        File archive=new File(new File(workspace,"full-mobile"),imported.getString("previousBackupFile"));JSONObject archived=new JSONObject(new String(Files.readAllBytes(archive.toPath()),StandardCharsets.UTF_8));check(archived.getJSONObject("state").getJSONArray("goals").length()==2,"restore first archives previous full mobile state");
        JSONObject bad=LedgerStore.copy(backupSnapshot);bad.getJSONObject("state").getJSONArray("accounts").getJSONObject(0).put("openingBalance",0.5);before=store.snapshot().toString();try{store.restoreBackup(bad);throw new AssertionError("invalid import accepted");}catch(AssertionError e){throw e;}catch(Exception expected){}check(before.equals(store.snapshot().toString()),"invalid import never mutates original store");

        store=fresh(new File(workspace,"entity-overlay"));store.saveAccount(MobileLedgerTest.account("bank","CNY",10000,null));store.saveGoal(new JSONObject().put("id","goal").put("name","目标").put("target",10000));store.saveSettings(new JSONObject().put("monthlyBudget",50000));store.saveManual(tx("local",500));
        JSONObject queued=store.syncRequest(UUID.randomUUID().toString());String accountOp=queued.getJSONArray("operations").getJSONObject(0).getString("id");store.applyResponse(response(queued,state(new JSONArray()),new JSONArray().put(accountOp),new JSONArray()),queued);
        JSONObject overlay=store.snapshot();check(overlay.getJSONArray("operations").length()==3&&overlay.getJSONObject("state").getJSONArray("goals").length()==1&&overlay.getJSONObject("state").getJSONObject("settings").getLong("monthlyBudget")==50000&&overlay.getJSONObject("state").getJSONArray("transactions").length()==1,"partial ACK preserves unacknowledged entities and transactions");
        JSONObject settingOp=null;for(int i=0;i<overlay.getJSONArray("operations").length();i++){JSONObject entry=overlay.getJSONArray("operations").getJSONObject(i);if(entry.optString("entity").equals("settings"))settingOp=entry;}
        JSONObject request2=store.syncRequest(UUID.randomUUID().toString()),remoteState=state(new JSONArray());remoteState.getJSONObject("settings").put("monthlyBudget",60000);
        JSONArray settingsConflict=new JSONArray().put(new JSONObject().put("operationId",settingOp.getString("id")).put("reason","预算已修改").put("current",remoteState.getJSONObject("settings")));
        store.applyResponse(response(request2,remoteState,new JSONArray(),settingsConflict),request2);store.resolveConflict(settingOp.getString("id"),false);
        check(store.snapshot().getJSONObject("state").getJSONObject("settings").getLong("monthlyBudget")==60000&&store.snapshot().getJSONObject("state").getJSONArray("goals").length()==1,"choosing desktop settings preserves unrelated unsynced goals");

        store=fresh(new File(workspace,"account-tombstone"));store.saveAccount(MobileLedgerTest.account("cash","CNY",1,null));store.deleteAccount("cash");JSONObject tombstone=store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").getJSONObject(0);check(tombstone.getString("kind").equals("delete")&&tombstone.getJSONObject("base").getString("id").equals("cash"),"new account delete retains tombstone for lost acknowledgement");

        store=fresh(new File(workspace,"deleted-dependency"));pair(store,new JSONArray());store.saveManual(tx("waiting",900));JSONObject missingRequest=store.syncRequest(UUID.randomUUID().toString());String waitingOp=missingRequest.getJSONArray("operations").getJSONObject(0).getString("id");
        store.applyResponse(response(missingRequest,MobileLedger.emptyState(),new JSONArray(),new JSONArray().put(new JSONObject().put("operationId",waitingOp).put("current",JSONObject.NULL).put("reason","账户已删除"))),missingRequest);
        check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==1&&store.snapshot().getJSONObject("state").getJSONArray("accounts").length()==1,"desktop account deletion retains local pending transaction and dependency snapshot");
        check(store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").length()==0,"dependency conflict remains reviewable and does not block pull-only sync");
        store.resolveConflict(waitingOp,false);check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==0&&store.snapshot().getJSONObject("state").getJSONArray("accounts").length()==0,"choosing desktop removes orphan preview without resurrecting deleted account");

        store=fresh(new File(workspace,"funding-routing"));store.saveAccount(MobileLedgerTest.account("wallet","CNY",5000,null).put("providerId","wechat"));store.saveAccount(MobileLedgerTest.account("card","CNY",10000,null).put("providerId","bank-card").put("bankId","cmb").put("lastFour","1234"));store.setCapture(true);store.setSource("com.tencent.mm","微信支付",true,"wallet");
        PaymentParser.Parsed receipt=new PaymentParser.Parsed();receipt.amount=2800;receipt.confident=true;receipt.knownSource=true;receipt.completed=true;receipt.paymentChannel="wechat";receipt.fundingSource="bank";receipt.bankId="cmb";receipt.lastFour="1234";receipt.title="商户消费";receipt.category="餐饮";receipt.reference="order123456";receipt.amountBasis="actual";receipt.transactionKind="payment";receipt.snippet="明确银行卡付款";
        long posted=System.currentTimeMillis();store.capture("com.tencent.mm","notify1",posted,receipt);JSONObject routed=store.snapshot().getJSONObject("state");check(routed.getJSONArray("transactions").getJSONObject(0).getString("accountId").equals("card")&&MobileLedger.balances(routed,LedgerStore.today()).getLong("wallet")==5000,"bound card payment never debits default WeChat wallet");
        receipt.captureMethod="screen";receipt.reference="order654321";store.capture("com.tencent.mm","screen1",posted+1000,receipt);check(store.snapshot().getJSONArray("pending").length()==0,"screen capture requires its separate opt-in");
        store.setScreenCaptureEnabled(true);store.capture("com.tencent.mm","screen1",posted+1000,receipt);check(store.snapshot().getJSONArray("pending").length()==1&&store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==1,"screen capture remains pending despite exact funding evidence");
        receipt.captureMethod="notification";store.capture("com.tencent.mm","notify2",posted+2000,receipt);check(store.snapshot().getJSONArray("pending").length()==1&&store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==1,"same order across page and notification is durably deduplicated");
        receipt.reference="order777777";store.capture("com.tencent.mm","notify3",posted+3000,receipt);check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==2,"distinct order references preserve separate same-price payments");
        receipt.reference="";receipt.captureMethod="screen";store.capture("com.tencent.mm","screen2",posted+4000,receipt);check(store.snapshot().getJSONArray("pending").getJSONObject(1).getString("reason").contains("重复"),"weak same-price evidence requests review rather than silently discarding payment");
        receipt.knownSource=false;receipt.captureMethod="notification";receipt.reference="unknown888";store.capture("com.tencent.mm","notify4",posted+5000,receipt);check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==2,"untrusted parser source cannot auto-post even with a default mapping");
        receipt.knownSource=true;receipt.transactionKind="refund";receipt.type="income";receipt.confident=false;receipt.reason="退款请核对";receipt.reference="order123456";int pendingCount=store.snapshot().getJSONArray("pending").length();store.capture("com.tencent.mm","refund-notice",posted+6000,receipt);check(store.snapshot().getJSONArray("pending").length()==pendingCount+1,"refund reusing the payment order number is retained for review");
        store.saveAccount(new JSONObject().put("id","card").put("bankId",JSONObject.NULL).put("lastFour",JSONObject.NULL).put("providerId",JSONObject.NULL));JSONObject cleared=MobileLedger.find(store.snapshot().getJSONObject("state").getJSONArray("accounts"),"card");check(!cleared.has("bankId")&&!cleared.has("lastFour")&&!cleared.has("providerId"),"explicit null removes editable optional account metadata");

        store=fresh(new File(workspace,"apple-try"));
        JSONObject apple=MobileLedgerTest.account("apple_tr","TRY",10025,"0.15").put("providerId","apple-balance").put("type","Apple 账户余额").put("appleRegion","TR").put("appleAccount","test@example.com");
        store.saveAccount(apple);store.saveAccount(new JSONObject().put("id","apple_tr").put("name","土耳其余额").put("openingBalance",20050));
        JSONObject savedApple=MobileLedger.find(store.snapshot().getJSONObject("state").getJSONArray("accounts"),"apple_tr");
        check(savedApple.getString("providerId").equals("apple-balance")&&savedApple.getString("appleRegion").equals("TR")&&savedApple.getString("appleAccount").equals("test@example.com"),"editing Apple balance preserves provider, region and account association");
        check(savedApple.getLong("openingBalance")==20050&&savedApple.getString("currency").equals("TRY"),"TRY opening balance edits retain native denomination");
        JSONObject appleRequest=store.syncRequest(UUID.randomUUID().toString());JSONObject appleValue=appleRequest.getJSONArray("operations").getJSONObject(0).getJSONObject("record");
        check(appleValue.getString("appleRegion").equals("TR")&&appleValue.getString("appleAccount").equals("test@example.com"),"outbound sync keeps Apple metadata");
        before=store.snapshot().toString();try{store.saveAccount(new JSONObject().put("id","apple_tr").put("appleRegion","JP"));throw new AssertionError("mismatched Apple region accepted");}catch(AssertionError e){throw e;}catch(Exception expected){check(expected.getMessage().contains("币种不一致"),"mismatched region explains the required currency");}check(before.equals(store.snapshot().toString()),"invalid Apple edit preserves balance, metadata and pending queue");
        JSONObject appleBackup=store.snapshot();store.saveAccount(new JSONObject().put("id","apple_tr").put("appleAccount","changed@example.com"));store.restoreBackup(appleBackup);
        JSONObject restoredApple=MobileLedger.find(store.snapshot().getJSONObject("state").getJSONArray("accounts"),"apple_tr");
        check(restoredApple.getString("appleAccount").equals("test@example.com")&&restoredApple.getString("appleRegion").equals("TR")&&restoredApple.getString("currency").equals("TRY")&&restoredApple.getLong("openingBalance")==20050,"full mobile backup roundtrip preserves Apple association and native balance");
        check(store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").getJSONObject(0).getJSONObject("record").getString("appleAccount").equals("test@example.com"),"restored pending account sync keeps the original Apple identity");
        JSONObject invalidAppleBackup=LedgerStore.copy(appleBackup);invalidAppleBackup.getJSONObject("state").getJSONArray("accounts").getJSONObject(0).put("appleRegion","US");before=store.snapshot().toString();try{store.restoreBackup(invalidAppleBackup);throw new AssertionError("mismatched Apple backup accepted");}catch(AssertionError e){throw e;}catch(Exception expected){}check(before.equals(store.snapshot().toString()),"invalid Apple backup does not replace the current ledger");
        store.saveAccount(new JSONObject().put("id","apple_tr").put("type","其他账户").put("providerId",JSONObject.NULL).put("appleRegion",JSONObject.NULL).put("appleAccount",JSONObject.NULL));
        JSONObject converted=MobileLedger.find(store.snapshot().getJSONObject("state").getJSONArray("accounts"),"apple_tr");
        check(!converted.has("providerId")&&!converted.has("appleRegion")&&!converted.has("appleAccount"),"changing Apple balance to a regular account clears incompatible metadata");

        store=fresh(new File(workspace,"immutable-duplicate"));JSONObject existing=tx("existing",100);pair(store,new JSONArray().put(existing));store.saveManual(tx("new-duplicate",200));JSONObject duplicateRequest=store.syncRequest(UUID.randomUUID().toString());String duplicateOp=duplicateRequest.getJSONArray("operations").getJSONObject(0).getString("id");
        store.applyResponse(response(duplicateRequest,state(new JSONArray().put(existing)),new JSONArray(),new JSONArray().put(new JSONObject().put("operationId",duplicateOp).put("current",JSONObject.NULL).put("candidate",existing).put("reason","同一条通知内容变化").put("canKeepPhone",false).put("resolutionHint","请采用电脑记录后编辑已有账单"))),duplicateRequest);
        before=store.snapshot().toString();try{store.resolveConflict(duplicateOp,true);throw new AssertionError("immutable duplicate incorrectly resubmitted");}catch(AssertionError e){throw e;}catch(Exception expected){check(expected.getMessage().contains("编辑已有账单"),"immutable duplicate gives actionable guidance");}check(before.equals(store.snapshot().toString()),"blocked duplicate resolution does not alter queued work or another record");
        store.resolveConflict(duplicateOp,false);check(store.snapshot().getJSONObject("state").getJSONArray("transactions").length()==1&&store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0).getString("id").equals("existing"),"adopting candidate leaves existing transaction unchanged");
        System.out.println("LedgerStore: " + checks + " checks passed (host adapters, not Android runtime)");
    }
}
