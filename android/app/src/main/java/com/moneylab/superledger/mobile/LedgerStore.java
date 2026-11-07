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
import java.time.ZonedDateTime;
import java.util.ArrayList;
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
                .put("state", MobileLedger.emptyState())
                .put("operations", new JSONArray()).put("pending", new JSONArray()).put("conflicts", new JSONArray())
                .put("seen", new JSONArray()).put("sources", new JSONObject()).put("mappings", new JSONObject()).put("captureEnabled", false).put("screenCaptureEnabled",false);
            for (String[] source : SOURCES) data.getJSONObject("sources").put(source[0], new JSONObject().put("name", source[1]).put("enabled", true));
            persist();
        }
        data.put("state", MobileLedger.upgradeLegacyState(data.getJSONObject("state")));
        if(!data.has("screenCaptureEnabled"))data.put("screenCaptureEnabled",false);
        if(data.optJSONObject("serverState")!=null&&!fundingWaits().isEmpty())rebuildLocalState(copy(state()));
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
    public synchronized void setScreenCaptureEnabled(boolean enabled) throws Exception {change(()->data.put("screenCaptureEnabled",enabled));}
    public synchronized void setSource(String pkg, String label, boolean enabled, String accountId) throws Exception {
        if (!pkg.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")) throw new Exception("应用包名格式不正确");
        change(() -> {
            data.getJSONObject("sources").put(pkg, new JSONObject().put("name", label).put("enabled", enabled));
            if (accountId == null || accountId.isEmpty()) data.getJSONObject("mappings").remove(pkg);
            else data.getJSONObject("mappings").put(pkg, accountId);
        });
    }
    public static String today() { return date(System.currentTimeMillis()); }
    public static String date(long millis) { return MobileLedger.beijingDateTime(millis).toLocalDate().toString(); }
    public static String hash(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.US, "%02x", b)); return result.toString();
    }
    private static JSONObject find(JSONArray array, String id) {
        for (int i = 0; i < array.length(); i++) { JSONObject item = array.optJSONObject(i); if (item != null && id.equals(item.optString("id"))) return item; } return null;
    }
    private static int findIndex(JSONArray array, String id) { for (int i = 0; i < array.length(); i++) if (array.optJSONObject(i) != null && id.equals(array.optJSONObject(i).optString("id"))) return i; return -1; }
    private static String entity(JSONObject op) { return op.optString("entity", "transaction"); }
    private static String collection(String entity) throws Exception {
        switch(entity){case "account":return "accounts";case "subscription":return "subscriptions";case "goal":return "goals";case "transaction":return "transactions";case "settings":return "settings";default:throw new Exception("不支持此同步实体");}
    }
    private static JSONObject record(JSONObject op) { return op.optJSONObject(entity(op).equals("transaction") ? "transaction" : "record"); }
    private static String recordId(JSONObject op) { if(entity(op).equals("settings"))return "settings"; if(op.has("recordId"))return op.optString("recordId");if(op.optString("kind").equals("delete"))return op.optString("transactionId");JSONObject value=record(op);return value==null?"":value.optString("id"); }
    private static JSONObject getRecord(JSONObject state,String entity,String id) throws Exception {return entity.equals("settings")?state.getJSONObject("settings"):find(state.getJSONArray(collection(entity)),id);}
    private static void applyRecord(JSONObject state,String entity,String id,JSONObject value) throws Exception {
        if(entity.equals("settings")){if(value==null)throw new Exception("设置不能删除");state.put("settings",copy(value));return;}
        JSONArray list=state.getJSONArray(collection(entity));int index=findIndex(list,id);if(value==null){if(index>=0)list.remove(index);}else if(index<0)list.put(copy(value));else list.put(index,copy(value));
        if(entity.equals("subscription")&&value==null){JSONArray txs=state.getJSONArray("transactions");for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);if(id.equals(tx.optString("subscriptionId"))){tx.remove("subscriptionId");tx.remove("occurrenceKey");}}}
    }
    private static boolean same(Object left,Object right) throws Exception {
        if(left==right)return true;if(left==null||right==null)return false;
        if(left instanceof JSONObject&&right instanceof JSONObject){JSONObject a=(JSONObject)left,b=(JSONObject)right;if(a.length()!=b.length())return false;Iterator<String> keys=a.keys();while(keys.hasNext()){String key=keys.next();if(!b.has(key)||!same(a.get(key),b.get(key)))return false;}return true;}
        if(left instanceof JSONArray&&right instanceof JSONArray){JSONArray a=(JSONArray)left,b=(JSONArray)right;if(a.length()!=b.length())return false;for(int i=0;i<a.length();i++)if(!same(a.get(i),b.get(i)))return false;return true;}
        if(left instanceof Number&&right instanceof Number)return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString()))==0;return left.equals(right);
    }
    private void requireIdle() throws Exception { if (syncing) throw new Exception("正在同步，请完成后再修改账单"); }
    private Set<String> fundingWaits() throws Exception {
        Set<String> waiting=new HashSet<>();JSONArray conflicts=data.getJSONArray("conflicts"),operations=data.getJSONArray("operations");
        for(int i=0;i<conflicts.length();i++){
            JSONObject conflict=conflicts.getJSONObject(i);if(!conflict.optBoolean("retryWhenFunded"))continue;
            int index=findIndex(operations,conflict.optString("operationId"));if(index<0)continue;
            JSONObject op=operations.getJSONObject(index),tx=record(op);
            if(entity(op).equals("transaction")&&op.optString("kind").equals("put")&&tx!=null&&tx.optString("type").equals("expense")&&tx.has("subscriptionId")&&tx.has("occurrenceKey"))waiting.add(op.getString("id"));
        }
        return waiting;
    }
    private boolean hasBlockingConflicts() throws Exception {
        Set<String> waiting=fundingWaits();JSONArray conflicts=data.getJSONArray("conflicts");
        for(int i=0;i<conflicts.length();i++)if(!waiting.contains(conflicts.getJSONObject(i).optString("operationId")))return true;
        return false;
    }
    private void queueRecord(String entity,String id,JSONObject value) throws Exception {
        JSONObject state=data.getJSONObject("state"),old=getRecord(state,entity,id);JSONArray operations=data.getJSONArray("operations");Object base=old==null?JSONObject.NULL:copy(old);int insertion=operations.length();Set<String> superseded=new HashSet<>();
        for(int i=0;i<operations.length();i++){JSONObject op=operations.getJSONObject(i);if(entity.equals(entity(op))&&id.equals(recordId(op))){if(insertion==operations.length()){insertion=i;base=op.opt("base");}superseded.add(op.getString("id"));}}
        for(int i=operations.length()-1;i>=0;i--)if(superseded.contains(operations.getJSONObject(i).getString("id")))operations.remove(i);
        if(value==null&&(base==null||base==JSONObject.NULL))base=old==null?JSONObject.NULL:copy(old);
        JSONObject op=new JSONObject().put("id",UUID.randomUUID().toString()).put("kind",value==null?"delete":"put").put("entity",entity).put("recordId",id).put("base",base==null?JSONObject.NULL:base);
        if(value!=null){op.put("record",copy(value));if(entity.equals("transaction"))op.put("transaction",copy(value)).put("allowDuplicate",false);}else if(entity.equals("transaction"))op.put("transactionId",id);
        JSONArray ordered=new JSONArray();for(int i=0;i<=operations.length();i++){if(i==Math.min(insertion,operations.length()))ordered.put(op);if(i<operations.length())ordered.put(operations.getJSONObject(i));}data.put("operations",ordered);
        JSONArray conflicts=data.getJSONArray("conflicts");for(int i=conflicts.length()-1;i>=0;i--)if(superseded.contains(conflicts.getJSONObject(i).optString("operationId")))conflicts.remove(i);
        applyRecord(state,entity,id,value);
    }
    private void queuePut(JSONObject tx) throws Exception {
        queueRecord("transaction",tx.getString("id"),tx);
    }
    public synchronized void putTransaction(JSONObject tx, String pendingId) throws Exception {
        requireIdle();
        change(() -> { JSONObject value=prepareManual(tx);queuePut(value);MobileLedger.validateState(data.getJSONObject("state")); if (pendingId != null) { int idx = findIndex(data.getJSONArray("pending"), pendingId); if (idx >= 0) data.getJSONArray("pending").remove(idx); } applyRecurringInternal(); });
    }
    public synchronized void deleteTransaction(String id) throws Exception {
        deleteManual(id);
    }
    private JSONObject state() throws Exception {return data.getJSONObject("state");}
    private static void defaultValue(JSONObject value,String key,Object fallback) throws Exception {if(!value.has(key))value.put(key,fallback);}
    private JSONObject mergedRecord(String entity,JSONObject input,String prefix) throws Exception {
        JSONObject value=copy(input);String id=value.optString("id");if(id.isEmpty())id=prefix+UUID.randomUUID();value.put("id",id);JSONObject merged=MobileLedger.merge(getRecord(state(),entity,id),value);
        String[] clearable=entity.equals("account")?new String[]{"providerId","bankId","lastFour","rateAsOf","rateSource","appleRegion","appleAccount"}:entity.equals("subscription")?new String[]{"serviceId"}:entity.equals("goal")?new String[]{"cover"}:new String[0];
        for(String key:clearable)if(input.has(key)&&input.isNull(key))merged.remove(key);return merged;
    }
    private void promoteSchema() throws Exception {
        int schema=state().getInt("schemaVersion");
        JSONArray accounts=state().getJSONArray("accounts"),subscriptions=state().getJSONArray("subscriptions");
        for(int i=0;i<accounts.length();i++)if(!MobileLedger.currency(accounts.getJSONObject(i)).equals("CNY"))schema=Math.max(schema,2);
        for(int i=0;i<subscriptions.length();i++)if(subscriptions.getJSONObject(i).has("startHour")||subscriptions.getJSONObject(i).has("billingHour"))schema=3;
        state().put("schemaVersion",schema);
    }
    public synchronized void saveAccount(JSONObject input) throws Exception {
        requireIdle();change(()->{JSONObject value=mergedRecord("account",input,"acc_"),old=getRecord(state(),"account",value.getString("id"));defaultValue(value,"type","其他账户");defaultValue(value,"color","#8bc8ab");defaultValue(value,"openingBalance",0);defaultValue(value,"currency","CNY");
            if(old!=null&&!MobileLedger.currency(old).equals(MobileLedger.currency(value))){String id=old.getString("id");JSONArray txs=state().getJSONArray("transactions"),subs=state().getJSONArray("subscriptions");for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);if(id.equals(tx.optString("accountId"))||id.equals(tx.optString("toAccountId")))throw new Exception("账户已有交易，不能更改币种");}for(int i=0;i<subs.length();i++)if(id.equals(subs.getJSONObject(i).optString("accountId")))throw new Exception("账户已有关联订阅，不能更改币种");}
            if(MobileLedger.currency(value).equals("CNY")){value.remove("cnyRate");value.remove("rateMode");value.remove("rateAsOf");value.remove("rateSource");}else{value.put("cnyRate",MobileLedger.currencyRate(value));defaultValue(value,"rateMode","manual");}
            queueRecord("account",value.getString("id"),value);promoteSchema();MobileLedger.validateState(state());applyRecurringInternal();});
    }
    public synchronized void deleteAccount(String id) throws Exception {
        requireIdle();change(()->{if(getRecord(state(),"account",id)==null)return;JSONArray txs=state().getJSONArray("transactions"),subs=state().getJSONArray("subscriptions");for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);if(id.equals(tx.optString("accountId"))||id.equals(tx.optString("toAccountId")))throw new Exception("账户有关联账单，请先调整交易账户");}for(int i=0;i<subs.length();i++)if(id.equals(subs.getJSONObject(i).optString("accountId")))throw new Exception("账户有关联订阅，请先调整扣款账户");queueRecord("account",id,null);JSONObject mappings=data.getJSONObject("mappings");List<String> remove=new ArrayList<>();Iterator<String> keys=mappings.keys();while(keys.hasNext()){String key=keys.next();if(id.equals(mappings.optString(key)))remove.add(key);}for(String key:remove)mappings.remove(key);MobileLedger.validateState(state());});
    }
    private JSONObject prepareManual(JSONObject input) throws Exception {
        JSONObject value=mergedRecord("transaction",input,"mob_"),old=getRecord(state(),"transaction",value.getString("id"));String type=value.optString("type");JSONObject account=getRecord(state(),"account",value.optString("accountId"));if(account==null)throw new Exception("请先创建或选择账户");String currency=MobileLedger.currency(account);value.put("currency",currency);defaultValue(value,"note","");defaultValue(value,"date",today());
        if(value.getString("date").compareTo(today())>0)throw new Exception("普通账单请使用今天或过去的日期，未来费用请添加为订阅");
        if(currency.equals("CNY"))value.remove("cnyRate");else if(input.has("cnyRate"))value.put("cnyRate",MobileLedger.normalizeRate(input.getString("cnyRate")));else if(old==null||!currency.equals(MobileLedger.currency(old))||!old.optString("accountId").equals(value.optString("accountId")))value.put("cnyRate",MobileLedger.currencyRate(account));
        if(type.equals("transfer")){JSONObject target=getRecord(state(),"account",value.optString("toAccountId"));if(target==null)throw new Exception("请选择转入账户");value.put("toCurrency",MobileLedger.currency(target)).put("category","账户转账");if(currency.equals(MobileLedger.currency(target)))value.put("toAmount",value.get("amount"));}
        else {value.remove("toAccountId");value.remove("toAmount");value.remove("toCurrency");}
        String recordedDate=value.getString("date"),month=recordedDate.substring(0,Math.min(7,recordedDate.length()));
        if(old!=null&&old.has("subscriptionId")&&(!type.equals("expense")||!old.getString("date").substring(0,7).equals(month))) {value.remove("subscriptionId");value.remove("occurrenceKey");}
        return value;
    }
    public synchronized void saveManual(JSONObject input) throws Exception {putTransaction(input,null);}
    public synchronized void deleteManual(String id) throws Exception {requireIdle();change(()->{if(getRecord(state(),"transaction",id)==null)return;queueRecord("transaction",id,null);MobileLedger.validateState(state());applyRecurringInternal();});}
    public synchronized void saveGoal(JSONObject input) throws Exception {requireIdle();change(()->{JSONObject value=mergedRecord("goal",input,"goal_");defaultValue(value,"color","#c7dfa2");defaultValue(value,"saved",0);queueRecord("goal",value.getString("id"),value);MobileLedger.validateState(state());});}
    public synchronized void deleteGoal(String id) throws Exception {requireIdle();change(()->{if(getRecord(state(),"goal",id)!=null)queueRecord("goal",id,null);MobileLedger.validateState(state());});}
    public synchronized void saveSettings(JSONObject input) throws Exception {requireIdle();change(()->{JSONObject value=MobileLedger.merge(state().getJSONObject("settings"),input);queueRecord("settings","settings",value);MobileLedger.validateState(state());});}
    public synchronized void saveSubscription(JSONObject input) throws Exception {
        requireIdle();change(()->{JSONObject value=mergedRecord("subscription",input,"sub_"),old=getRecord(state(),"subscription",value.getString("id"));JSONObject account=getRecord(state(),"account",value.optString("accountId"));if(account==null)throw new Exception("请选择订阅扣款账户");value.put("currency",MobileLedger.currency(account)).put("category","会员订阅");defaultValue(value,"active",true);defaultValue(value,"recurring",true);defaultValue(value,"color","#8bc8ab");defaultValue(value,"icon","repeat");defaultValue(value,"tier","");defaultValue(value,"billingDay",Integer.parseInt(value.getString("startDate").substring(8)));
            // Billing history is not user-editable; retaining it prevents deleted charges being recreated.
            value.put("processedOccurrences",old==null?new JSONArray():copyArray(old.getJSONArray("processedOccurrences")));
            if(old!=null&&old.has("expiryRenewal"))value.put("expiryRenewal",copy(old.getJSONObject("expiryRenewal")));else value.remove("expiryRenewal");
            if(old!=null&&(!old.optString("expiresOn").equals(value.optString("expiresOn"))||old.getBoolean("recurring")!=value.getBoolean("recurring")))
                value=MobileLedger.resetSubscriptionExpiry(value,state().getJSONArray("transactions"));
            ZonedDateTime now=MobileLedger.beijingDateTime(System.currentTimeMillis());
            if(old!=null&&!old.getBoolean("active")&&value.getBoolean("active")){value.put("active",false);value=MobileLedger.setSubscriptionActive(value,true,now.toLocalDate().toString(),now.getHour());}
            queueRecord("subscription",value.getString("id"),value);promoteSchema();MobileLedger.validateState(state());applyRecurringInternal(now.toLocalDate().toString(),now.getHour());});
    }
    public synchronized void deleteSubscription(String id) throws Exception {
        requireIdle();change(()->{if(getRecord(state(),"subscription",id)==null)return;queueRecord("subscription",id,null);
            // A not-yet-sent recurring expense remains a real expense after deleting its subscription.
            JSONArray ops=data.getJSONArray("operations");for(int i=0;i<ops.length();i++){JSONObject op=ops.getJSONObject(i),tx=record(op);if(entity(op).equals("transaction")&&op.optString("kind").equals("put")&&tx!=null&&id.equals(tx.optString("subscriptionId"))){JSONObject detached=copy(tx);detached.remove("subscriptionId");detached.remove("occurrenceKey");op.put("transaction",detached).put("record",copy(detached));}}
            MobileLedger.validateState(state());});
    }
    private void applyRecurringInternal(String date,int currentHour) throws Exception {
        JSONObject result=MobileLedger.applyRecurring(state(),date,currentHour),next=result.getJSONObject("state");JSONArray subs=next.getJSONArray("subscriptions");
        for(int i=0;i<subs.length();i++){JSONObject sub=subs.getJSONObject(i);if(!same(getRecord(state(),"subscription",sub.getString("id")),sub))queueRecord("subscription",sub.getString("id"),sub);}
        JSONArray added=result.getJSONArray("added");for(int i=0;i<added.length();i++)queuePut(added.getJSONObject(i));MobileLedger.validateState(state());
    }
    private void applyRecurringInternal() throws Exception {
        if(hasBlockingConflicts())return;
        ZonedDateTime now=MobileLedger.beijingDateTime(System.currentTimeMillis());
        applyRecurringInternal(now.toLocalDate().toString(),now.getHour());
    }
    private void persistRecurring(String date,int currentHour) throws Exception {if(hasBlockingConflicts())return;JSONObject previous=copy(data);try{applyRecurringInternal(date,currentHour);if(!same(previous,data))persist();}catch(Exception error){data=previous;throw error;}}
    private void persistRecurring() throws Exception {ZonedDateTime now=MobileLedger.beijingDateTime(System.currentTimeMillis());persistRecurring(now.toLocalDate().toString(),now.getHour());}
    public synchronized void applyRecurring(String date) throws Exception {requireIdle();persistRecurring(date,23);}
    public synchronized void applyRecurring() throws Exception {requireIdle();persistRecurring();}
    /** Import the complete mobile backup only after UI confirmation; archive the current complete store first. */
    public synchronized void restoreBackup(JSONObject backup) throws Exception {
        requireIdle();JSONObject replacement=copy(backup);replacement.remove("captureError");
        if(replacement.toString().getBytes(StandardCharsets.UTF_8).length>16*1024*1024||replacement.optInt("version")!=1||!replacement.optString("deviceId").matches("[A-Za-z0-9_-]{1,128}"))throw new Exception("请选择完整的手机备份 JSON（最多 16 MB）");
        JSONObject restored=MobileLedger.upgradeLegacyState(replacement.getJSONObject("state"));MobileLedger.validateState(restored);replacement.put("state",restored);
        for(String field:new String[]{"operations","pending","conflicts","seen"})if(replacement.optJSONArray(field)==null)throw new Exception("手机备份缺少 "+field);
        for(String field:new String[]{"sources","mappings"})if(replacement.optJSONObject(field)==null)throw new Exception("手机备份缺少 "+field);
        if(!(replacement.opt("captureEnabled") instanceof Boolean)||!replacement.has("bookId")||!replacement.isNull("bookId")&&!replacement.optString("bookId").matches("[A-Za-z0-9_-]{1,128}"))throw new Exception("手机备份配对或采集设置无效");
        if(replacement.getJSONArray("pending").length()>3000||replacement.getJSONArray("seen").length()>8000)throw new Exception("手机备份待确认列表超过上限");
        JSONArray ops=replacement.getJSONArray("operations");Set<String> opIds=new HashSet<>();for(int i=0;i<ops.length();i++){JSONObject op=ops.getJSONObject(i);collection(entity(op));if(!op.optString("id").matches("[A-Za-z0-9_-]{1,128}")||!opIds.add(op.getString("id"))||!op.optString("kind").matches("put|delete")||!recordId(op).matches("[A-Za-z0-9_-]{1,128}")||!op.has("base")||!op.isNull("base")&&op.optJSONObject("base")==null)throw new Exception("手机备份同步队列无效");if(op.optString("kind").equals("put")&&(record(op)==null||!entity(op).equals("settings")&&!recordId(op).equals(record(op).optString("id"))))throw new Exception("手机备份同步记录无效");if(entity(op).equals("settings")&&op.optString("kind").equals("delete"))throw new Exception("设置不可删除");if(op.optJSONObject("base")!=null&&!entity(op).equals("settings")&&!recordId(op).equals(op.getJSONObject("base").optString("id")))throw new Exception("手机备份同步基线不匹配");if(entity(op).equals("transaction")&&op.has("record")&&op.has("transaction")&&!same(op.get("record"),op.get("transaction")))throw new Exception("手机备份交易内容不一致");}
        JSONArray pending=replacement.getJSONArray("pending");Set<String> pendingIds=new HashSet<>();for(int i=0;i<pending.length();i++){JSONObject item=pending.getJSONObject(i),tx=item.optJSONObject("transaction");if(!item.optString("id").matches("[A-Za-z0-9_-]{1,128}")||!pendingIds.add(item.getString("id"))||tx==null||!tx.optString("type").matches("income|expense|transfer")||!(tx.opt("amount") instanceof Number))throw new Exception("手机备份待确认记录无效");}
        JSONArray conflicts=replacement.getJSONArray("conflicts");Set<String> conflictIds=new HashSet<>();for(int i=0;i<conflicts.length();i++){String id=conflicts.getJSONObject(i).optString("operationId");if(!opIds.contains(id)||!conflictIds.add(id))throw new Exception("手机备份冲突与同步队列不匹配");}
        JSONArray seen=replacement.getJSONArray("seen");for(int i=0;i<seen.length();i++)if(!(seen.get(i) instanceof String)||seen.getString(i).length()>256)throw new Exception("手机备份来源标识无效");
        if(replacement.has("serverState"))MobileLedger.validateState(MobileLedger.upgradeLegacyState(replacement.getJSONObject("serverState")));
        if(!replacement.has("screenCaptureEnabled"))replacement.put("screenCaptureEnabled",false);else if(!(replacement.opt("screenCaptureEnabled") instanceof Boolean))throw new Exception("页面辅助识别设置无效");
        // Keep the old state, queues, conflicts and notifications in a separate durable file, avoiding recursive archives.
        AtomicFile archive=new AtomicFile(new File(file.getBaseFile().getParentFile(),"mobile-ledger-before-import-"+System.currentTimeMillis()+"-"+UUID.randomUUID()+".json"));FileOutputStream output=null;
        try{output=archive.startWrite();output.write(data.toString().getBytes(StandardCharsets.UTF_8));archive.finishWrite(output);}catch(Exception error){if(output!=null)archive.failWrite(output);throw new Exception("无法保留导入前备份，未替换当前账本",error);}
        change(()->{data=replacement;data.put("lastRestoreAt",System.currentTimeMillis()).put("previousBackupFile",archive.getBaseFile().getName());});
    }
    public synchronized void dismissPending(String id) throws Exception { requireIdle(); change(() -> { int idx = findIndex(data.getJSONArray("pending"), id); if (idx >= 0) data.getJSONArray("pending").remove(idx); }); }
    public synchronized void capture(String pkg, String notificationKey, long postedAt, PaymentParser.Parsed parsed) throws Exception {
        if (parsed==null||!sourceEnabled(pkg)||parsed.captureMethod.equals("screen")&&!data.optBoolean("screenCaptureEnabled")) return;
        // Refund/repayment notices may reuse the original order number. Keep their review records
        // separate from the payment while preserving the historical key for ordinary payments.
        String eventNamespace=parsed.transactionKind.matches("refund|transfer|recharge|withdrawal|repayment")?parsed.transactionKind+":":"";
        String sourceKey = hash(pkg + "|" + (parsed.reference.isEmpty() ? notificationKey + "|" + postedAt + "|" + parsed.snippet : "reference:"+eventNamespace + parsed.reference));
        JSONArray seen = data.getJSONArray("seen"); for (int i = 0; i < seen.length(); i++) if (sourceKey.equals(seen.optString(i))) return;
        change(() -> {
            JSONArray seenList = data.getJSONArray("seen"); seenList.put(sourceKey); while (seenList.length() > 8000) seenList.remove(0);
            JSONObject capture = new JSONObject().put("sourcePackage", pkg).put("sourceKey", sourceKey).put("occurredAt", postedAt);
            if (!parsed.reference.isEmpty()) capture.put("reference", parsed.reference); if (!parsed.merchant.isEmpty()) capture.put("merchant", parsed.merchant);
            PaymentRouting.Result routing=PaymentRouting.match(parsed,state().getJSONArray("accounts"),data.getJSONObject("mappings").optString(pkg));String accountId=routing.accountId;
            capture.put("paymentChannel",parsed.paymentChannel).put("fundingSource",parsed.fundingSource).put("bankId",parsed.bankId).put("bankName",parsed.bankName).put("lastFour",parsed.lastFour).put("transactionKind",parsed.transactionKind).put("amountBasis",parsed.amountBasis).put("captureMethod",parsed.captureMethod).put("routingMethod",routing.method).put("amountCandidates",new JSONArray(parsed.amountCandidates));
            JSONObject tx = new JSONObject().put("id", "mob_" + UUID.randomUUID()).put("type", parsed.type).put("amount", parsed.amount)
                .put("accountId", accountId).put("category", parsed.category).put("title", parsed.title).put("date", date(postedAt)).put("note", "手机付款通知识别").put("currency", "CNY").put("mobileCapture", capture);
            String reason = parsed.reason;
            if (accountId.isEmpty()) reason = routing.reason.isEmpty()?"尚未确定扣款账户，请核对后入账":routing.reason;
            if (suspectedDuplicate(tx)) reason = "已有同金额、同日的相关交易或待确认记录，请核对是否重复或订阅扣款";
            if(parsed.captureMethod.equals("screen")&&reason.isEmpty())reason="页面辅助识别，请核对金额、实际付款账户和订单后入账";
            if(data.getJSONArray("conflicts").length()>0&&reason.isEmpty())reason="请先处理同步冲突，再确认这笔通知";
            boolean automatic=parsed.confident && parsed.knownSource && parsed.amount>0 && routing.exact && !parsed.captureMethod.equals("screen") && reason.isEmpty() && !syncing;
            if(automatic){try{JSONObject proposed=copy(state());applyRecord(proposed,"transaction",tx.getString("id"),tx);MobileLedger.validateState(proposed);}catch(Exception error){automatic=false;reason="暂不能自动入账，请核对："+error.getMessage();}}
            if (automatic) queuePut(tx);
            else {
                if (reason.isEmpty()) reason = "同步期间收到付款通知，请确认后入账";
                if (data.getJSONArray("pending").length() >= 3000) throw new Exception("待确认列表已满，请处理后继续采集");
                data.getJSONArray("pending").put(new JSONObject().put("id", UUID.randomUUID().toString()).put("transaction", tx).put("reason", reason).put("snippet", parsed.snippet).put("sourcePackage", pkg).put("accountCandidates",new JSONArray(routing.candidates)).put("amountCandidates",new JSONArray(parsed.amountCandidates)));
            }
            data.put("lastCaptureAt", System.currentTimeMillis());
        });
        captureError = "";
    }
    private boolean suspectedDuplicate(JSONObject tx) throws Exception {
        JSONArray transactions = copyArray(data.getJSONObject("state").getJSONArray("transactions")),pending=data.getJSONArray("pending");for(int i=0;i<pending.length();i++){JSONObject prior=pending.getJSONObject(i).optJSONObject("transaction");if(prior!=null)transactions.put(prior);}
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
        persistRecurring();
        Set<String> waiting=fundingWaits();
        Set<String> unresolved = new HashSet<>(); JSONArray conflicts = data.getJSONArray("conflicts");
        for (int i = 0; i < conflicts.length(); i++){String id=conflicts.getJSONObject(i).optString("operationId");if(!waiting.contains(id))unresolved.add(id);}
        JSONObject available=waiting.isEmpty()||hasBlockingConflicts()?null:MobileLedger.balances(state(),today());
        JSONArray selected = new JSONArray(), operations = data.getJSONArray("operations");
        JSONObject request = new JSONObject().put("protocolVersion",2).put("supportedSchemaVersion",3).put("schemaVersion",state().getInt("schemaVersion")).put("requestId", requestId).put("deviceId", data.getString("deviceId")).put("deviceName", Build.MANUFACTURER + " " + Build.MODEL)
            .put("bookId", data.opt("bookId")).put("operations", selected);
        int bytes = request.toString().getBytes(StandardCharsets.UTF_8).length;
        for (int i = 0; i < operations.length() && selected.length() < 500; i++) {
            JSONObject operation = operations.getJSONObject(i); if (unresolved.contains(operation.getString("id"))) continue;
            JSONObject charge=record(operation);boolean reserve=false;
            if(waiting.contains(operation.getString("id"))){
                boolean existing=false;JSONArray transactions=state().getJSONArray("transactions");
                for(int j=0;j<transactions.length();j++)if(charge.getString("occurrenceKey").equals(transactions.getJSONObject(j).optString("occurrenceKey"))){existing=true;break;}
                if(!existing){
                    if(available==null)continue;
                    JSONObject account=getRecord(state(),"account",charge.optString("accountId"));
                    if(account!=null&&MobileLedger.currency(account).equals(MobileLedger.currency(charge))){
                        if(available.getLong(charge.getString("accountId"))<charge.getLong("amount"))continue;
                        reserve=true;
                    }
                }
            }
            int size = operation.toString().getBytes(StandardCharsets.UTF_8).length + (selected.length() == 0 ? 0 : 1);
            if (bytes + size > 2 * 1024 * 1024) { if (selected.length() == 0) throw new Exception("单条修改超过同步容量上限，请缩短备注后再试"); break; }
            selected.put(copy(operation)); bytes += size;
            if(reserve)available.put(charge.getString("accountId"),available.getLong(charge.getString("accountId"))-charge.getLong("amount"));
        }
        return request;
    }
    public synchronized void applyResponse(JSONObject response, JSONObject sentRequest) throws Exception {
        String bookId = response.getString("bookId"); if (bookId.isEmpty()) throw new Exception("电脑未返回有效账本标识");
        if (!data.isNull("bookId") && !data.getString("bookId").equals(bookId)) throw new Exception("这不是此前配对的账本，手机待同步内容已保留");
        if (!response.optString("requestId").equals(sentRequest.optString("requestId"))) throw new Exception("同步响应不匹配，请重新扫码");
        JSONObject state = MobileLedger.upgradeLegacyState(response.getJSONObject("state")); MobileLedger.validateState(state);
        Set<String> accepted = new HashSet<>(); JSONArray ack = response.optJSONArray("accepted"); if (ack == null) throw new Exception("同步确认列表缺失");
        Set<String> sent = new HashSet<>(); JSONArray sentOps = sentRequest.getJSONArray("operations"); for (int i = 0; i < sentOps.length(); i++) sent.add(sentOps.getJSONObject(i).getString("id"));
        for (int i = 0; i < ack.length(); i++) { String id = ack.getString(i); if (!sent.contains(id)) throw new Exception("电脑返回了未知的同步确认"); accepted.add(id); }
        change(() -> {
            JSONObject fallback=copy(data.getJSONObject("state"));data.put("bookId", bookId).put("serverState",copy(state));
            JSONArray operations = data.getJSONArray("operations");
            for (int i = operations.length() - 1; i >= 0; i--) if (accepted.contains(operations.getJSONObject(i).getString("id"))) operations.remove(i);
            JSONArray mergedConflicts = new JSONArray(), returned = response.optJSONArray("conflicts") == null ? new JSONArray() : response.getJSONArray("conflicts"), previousConflicts = data.getJSONArray("conflicts");
            Set<String> returnedIds = new HashSet<>(); for (int i = 0; i < returned.length(); i++) returnedIds.add(returned.getJSONObject(i).optString("operationId"));
            for (int i = 0; i < previousConflicts.length(); i++) {
                JSONObject conflict = previousConflicts.getJSONObject(i); String id = conflict.optString("operationId"); int operationIndex = findIndex(operations, id);
                if (!accepted.contains(id) && !returnedIds.contains(id) && operationIndex >= 0) {
                    JSONObject latest = copy(conflict), operation = operations.getJSONObject(operationIndex);
                    JSONObject current = getRecord(state,entity(operation),recordId(operation)); latest.put("current", current == null ? JSONObject.NULL : copy(current)).put("entity",entity(operation));
                    JSONObject candidate = conflict.optJSONObject("candidate");
                    if (candidate != null) { JSONObject currentCandidate = getRecord(state,entity(operation),candidate.optString("id")); if (currentCandidate == null) latest.remove("candidate"); else latest.put("candidate", copy(currentCandidate)); }
                    mergedConflicts.put(latest);
                }
            }
            for (int i = 0; i < returned.length(); i++){int index=findIndex(operations, returned.getJSONObject(i).optString("operationId"));if(index>=0)mergedConflicts.put(copy(returned.getJSONObject(i)).put("entity",entity(operations.getJSONObject(index))));}
            data.put("conflicts", mergedConflicts);
            rebuildLocalState(fallback);
            data.put("lastSyncAt", System.currentTimeMillis()).put("lastSummary", response.optJSONObject("summary") == null ? new JSONObject() : response.getJSONObject("summary"));
            applyRecurringInternal();
        });
    }
    /** Overlay all unacknowledged entities; retain dependency snapshots for records awaiting conflict resolution. */
    private void rebuildLocalState(JSONObject fallback) throws Exception {
        JSONObject remote=data.optJSONObject("serverState");JSONObject next=copy(remote==null?fallback:remote);JSONArray ops=data.getJSONArray("operations");
        Set<String> waiting=fundingWaits();
        for(int i=0;i<ops.length();i++){JSONObject op=ops.getJSONObject(i);if(!waiting.contains(op.getString("id")))applyRecord(next,entity(op),recordId(op),op.optString("kind").equals("delete")?null:record(op));}
        JSONArray txs=next.getJSONArray("transactions"),subs=next.getJSONArray("subscriptions");
        for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);retainAccount(next,fallback,tx.optString("accountId"),tx.optString("currency","CNY"));if(tx.optString("type").equals("transfer"))retainAccount(next,fallback,tx.optString("toAccountId"),tx.optString("toCurrency","CNY"));if(tx.has("subscriptionId")&&find(subs,tx.optString("subscriptionId"))==null){JSONObject old=getRecord(fallback,"subscription",tx.optString("subscriptionId"));if(old!=null)applyRecord(next,"subscription",old.getString("id"),old);}}
        for(int i=0;i<subs.length();i++){JSONObject sub=subs.getJSONObject(i);retainAccount(next,fallback,sub.optString("accountId"),sub.optString("currency","CNY"));}
        data.put("state",next);promoteSchema();
        // Conflicting desktop edits may make the combined preview invalid. Preserve it and the queue;
        // user edits still undergo full validation, and choosing desktop rebuilds from serverState.
    }
    private static void retainAccount(JSONObject next,JSONObject fallback,String id,String currency) throws Exception {JSONObject current=getRecord(next,"account",id);if(current==null||!current.optString("currency","CNY").equals(currency)){JSONObject old=getRecord(fallback,"account",id);if(old!=null)applyRecord(next,"account",id,old);}}
    public synchronized void resolveConflict(String operationId, boolean keepPhone) throws Exception {
        requireIdle();
        change(() -> {
            JSONArray operations = data.getJSONArray("operations"), conflicts = data.getJSONArray("conflicts");
            JSONObject conflict = null; int conflictIndex = -1;
            for (int i = 0; i < conflicts.length(); i++) if (operationId.equals(conflicts.getJSONObject(i).optString("operationId"))) { conflict = conflicts.getJSONObject(i); conflictIndex = i; break; }
            int opIndex = findIndex(operations, operationId); if (conflict == null || opIndex < 0) throw new Exception("这条冲突已处理，请刷新");
            if(keepPhone&&!conflict.optBoolean("canKeepPhone",true))throw new Exception(conflict.optString("resolutionHint","此记录与已有账单属于同一笔，请采用电脑记录后编辑该账单；不会覆盖另一条记录。"));
            JSONObject op = operations.getJSONObject(opIndex), current = conflict.optJSONObject("current"),fallback=copy(state());
            if (!keepPhone) {
                operations.remove(opIndex);if(data.optJSONObject("serverState")==null)applyRecord(fallback,entity(op),recordId(op),current);
            } else {
                JSONObject revised = copy(op).put("id", UUID.randomUUID().toString()).put("base", current == null ? JSONObject.NULL : copy(current)).put("allowDuplicate", true);
                operations.put(opIndex, revised);
            }
            conflicts.remove(conflictIndex);
            rebuildLocalState(fallback);
            applyRecurringInternal();
        });
    }
    public synchronized void reconnectEmpty() throws Exception {
        requireIdle(); if (data.getJSONArray("operations").length() > 0) throw new Exception("还有未同步修改，请先同步或处理冲突，不能切换账本");
        change(() -> { data.put("bookId", JSONObject.NULL).put("state", MobileLedger.emptyState()).put("conflicts", new JSONArray()).put("mappings", new JSONObject());data.remove("serverState"); });
    }
    /** Called only after an explicit user export and recovery confirmation. */
    public synchronized void archiveForReconnect() throws Exception {
        requireIdle();
        change(() -> {
            JSONArray operations = data.getJSONArray("operations"), archives = data.optJSONArray("archives"); if (archives == null) archives = new JSONArray();
            archives.put(new JSONObject().put("bookId", data.opt("bookId")).put("archivedAt", System.currentTimeMillis()).put("state",copy(state())).put("operations", copyArray(operations)).put("conflicts", copyArray(data.getJSONArray("conflicts")))); data.put("archives", archives);
            JSONArray pending = data.getJSONArray("pending");
            if (pending.length() + operations.length() > 3000) throw new Exception("待确认数量超过上限，请先处理通知或保留完整导出备份后再恢复");
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.getJSONObject(i); if (!entity(operation).equals("transaction")||!operation.optString("kind").equals("put")) continue;
                JSONObject transaction = copy(record(operation)); transaction.put("id", "mob_" + UUID.randomUUID()).put("accountId", "").put("toAccountId",""); transaction.remove("subscriptionId"); transaction.remove("occurrenceKey");
                pending.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("transaction", transaction).put("reason", "从旧账本保留的未同步修改，请核对新账本是否已有此笔，并重新选择账户").put("snippet", "旧操作已存档，只有你确认后才会提交到新账本。").put("sourcePackage", "旧账本"));
            }
            data.put("bookId", JSONObject.NULL).put("state", MobileLedger.emptyState()).put("operations", new JSONArray()).put("conflicts", new JSONArray()).put("mappings", new JSONObject());data.remove("serverState");
        });
    }
}
