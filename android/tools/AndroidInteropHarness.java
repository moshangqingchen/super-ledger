import android.content.Context;
import com.moneylab.superledger.mobile.LedgerStore;
import com.moneylab.superledger.mobile.SyncClient;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.util.UUID;

/** Uses production SyncClient + LedgerStore; only Android platform types are adapted. */
public class AndroidInteropHarness {
  private static void check(boolean pass,String message) { if(!pass)throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    String action=args[0];
    LedgerStore store=LedgerStore.get(new Context(new File(args[1])));
    JSONObject output=new JSONObject();
    if(action.equals("schema4-create")) {
      store.saveSettings(new JSONObject().put("customCategories",new JSONObject().put("expense",new JSONArray().put("宠物")).put("income",new JSONArray().put("稿费"))).put("categoryBudgets",new JSONObject().put("宠物",4567)).put("schema4Opaque",new JSONObject().put("value","preserved")));
      store.saveGoal(new JSONObject().put("id","schema4_goal").put("name","有日期的心愿").put("target",10001).put("saved",101).put("deadline","2030-01-31"));
      store.saveSubscription(new JSONObject().put("id","schema4_annual").put("name","年付互操作").put("accountId","wallet").put("amount",101).put("startDate","2024-02-29").put("billingDay",31).put("intervalMonths",12).put("startHour",9).put("billingHour",18).put("recurring",true).put("active",true).put("expiresOn","2024-02-29"));
      JSONObject sub=com.moneylab.superledger.mobile.MobileLedger.find(store.snapshot().getJSONObject("state").getJSONArray("subscriptions"),"schema4_annual");
      output.put("nextDue",com.moneylab.superledger.mobile.MobileLedger.nextSubscriptionDue(sub,LedgerStore.today())).put("keys",sub.getJSONArray("processedOccurrences"));
    } else if(action.equals("schema4-edit")) {
      store.saveSettings(new JSONObject().put("monthlyBudget",765432));
    } else if(action.equals("full-ledger")) {
      store.saveAccount(new JSONObject().put("id","mobile_usd").put("name","手机美元账户").put("type","银行卡").put("color","#778899").put("currency","USD").put("cnyRate","7.2").put("rateMode","manual").put("openingBalance",10000));
      store.saveManual(new JSONObject().put("id","mobile_foreign_expense").put("type","expense").put("amount",1250).put("accountId","mobile_usd").put("currency","USD").put("cnyRate","7.1").put("title","美元消费").put("category","日用购物").put("note","").put("date",LedgerStore.today()));
      store.saveManual(new JSONObject().put("id","mobile_exchange").put("type","transfer").put("amount",7200).put("accountId","wallet").put("toAccountId","mobile_usd").put("toAmount",1000).put("currency","CNY").put("toCurrency","USD").put("title","账户换汇").put("category","账户转账").put("note","").put("date",LedgerStore.today()));
      store.saveGoal(new JSONObject().put("id","mobile_goal").put("name","手机储蓄心愿").put("target",500000).put("saved",25000).put("color","#778899"));
      store.saveSettings(new JSONObject().put("monthlyBudget",123456).put("currency","CNY"));
      store.saveSubscription(new JSONObject().put("id","mobile_sub").put("name","手机订阅").put("amount",500).put("currency","CNY").put("accountId","wallet").put("category","会员订阅").put("startDate",LedgerStore.today()).put("billingDay",Integer.parseInt(LedgerStore.today().substring(8))).put("active",true).put("recurring",true).put("icon","repeat").put("color","#778899").put("processedOccurrences",new JSONArray()));
    } else if(action.equals("membership-renew")) {
      String today=LedgerStore.today();
      store.saveSubscription(new JSONObject().put("id","renewing_membership").put("name","自动顺延会员").put("accountId","wallet").put("amount",100).put("category","会员订阅").put("startDate",today).put("billingDay",Integer.parseInt(today.substring(8))).put("recurring",true).put("active",true).put("expiresOn",today));
      output.put("expectedExpiry",LocalDate.parse(today).plusMonths(1).toString());
    } else if(action.equals("membership-edit-expiry")) {
      String expiry=LocalDate.parse(LedgerStore.today()).plusDays(10).toString();
      store.saveSubscription(new JSONObject().put("id","renewing_membership").put("expiresOn",expiry));output.put("expectedExpiry",expiry);
    } else if(action.equals("membership-unfunded")) {
      String today=LedgerStore.today();
      store.saveAccount(new JSONObject().put("id","funding_wallet").put("name","待补款钱包").put("type","现金").put("openingBalance",0));
      store.saveSubscription(new JSONObject().put("id","funding_member").put("name","余额不足会员").put("accountId","funding_wallet").put("amount",100).put("category","会员订阅").put("startDate",today).put("billingDay",Integer.parseInt(today.substring(8))).put("recurring",true).put("active",true).put("expiresOn",today));
      output.put("expectedExpiry",today);
    } else if(action.equals("membership-topup")) {
      String today=LedgerStore.today();
      store.saveManual(new JSONObject().put("id","funding_topup").put("type","income").put("accountId","funding_wallet").put("amount",100).put("date",today).put("title","订阅补款").put("category","其他收入").put("note",""));
      output.put("expectedExpiry",LocalDate.parse(today).plusMonths(1).toString());
    } else if(action.equals("stale-funding-wallet")) {
      store.saveAccount(new JSONObject().put("id","stale_wallet").put("name","离线缓存余额").put("type","现金").put("openingBalance",100));output.put("today",LedgerStore.today());
    } else if(action.equals("stale-funding-plan")) {
      String today=LedgerStore.today();
      store.saveSubscription(new JSONObject().put("id","stale_member").put("name","等待服务器资金恢复").put("accountId","stale_wallet").put("amount",100).put("category","会员订阅").put("startDate",today).put("billingDay",Integer.parseInt(today.substring(8))).put("recurring",true).put("active",true).put("expiresOn",today));
      output.put("expectedExpiry",LocalDate.parse(today).plusMonths(1).toString());
    } else if(action.equals("apple-edit")) {
      store.saveAccount(new JSONObject().put("id","desktop_apple_tr").put("openingBalance",20050));
    } else if(action.equals("apple-convert")) {
      store.saveAccount(new JSONObject().put("id","desktop_apple_tr").put("type","其他账户").put("providerId",JSONObject.NULL).put("appleRegion",JSONObject.NULL).put("appleAccount",JSONObject.NULL));
    } else if(action.equals("mobile-apple-create")) {
      String today=LedgerStore.today();
      store.saveAccount(new JSONObject().put("id","mobile_apple_tr").put("name","手机土耳其礼品卡余额").put("type","Apple 账户余额").put("providerId","apple-balance").put("appleRegion","TR").put("appleAccount","owner-mobile@example.com").put("color","#77728f").put("currency","TRY").put("cnyRate","0.15").put("rateMode","manual").put("openingBalance",10025));
      JSONArray linked=new JSONArray().put(new JSONObject().put("type","email").put("value","email-mobile@example.com")).put(new JSONObject().put("type","apple").put("value","owner-mobile@example.com")).put(new JSONObject().put("type","other").put("value","手机自定义账号"));
      store.saveSubscription(new JSONObject().put("id","mobile_apple_subscription").put("name","手机 Apple 会员").put("accountId","mobile_apple_tr").put("amount",999).put("currency","TRY").put("category","会员订阅").put("startDate",today).put("billingDay",Integer.parseInt(today.substring(8))).put("active",false).put("recurring",true).put("icon","repeat").put("color","#77728f").put("linkedAccounts",linked).put("expiresOn",LocalDate.parse(today).plusDays(30).toString()).put("note","手机创建的订阅备注").put("processedOccurrences",new JSONArray()));
    } else if(action.equals("mobile-apple-edit")) {
      store.saveAccount(new JSONObject().put("id","mobile_apple_tr").put("appleRegion","OTHER").put("appleAccount","edited-mobile@example.com").put("openingBalance",25075));
      store.saveSubscription(new JSONObject().put("id","mobile_apple_subscription").put("linkedAccounts",new JSONArray().put(new JSONObject().put("type","apple").put("value","edited-mobile@example.com"))).put("expiresOn",LocalDate.parse(LedgerStore.today()).plusDays(60).toString()).put("note","手机修改后的订阅备注"));
    } else if(action.equals("mobile-apple-clear")) {
      store.saveAccount(new JSONObject().put("id","mobile_apple_tr").put("appleRegion","TR").put("appleAccount",JSONObject.NULL));
      store.saveSubscription(new JSONObject().put("id","mobile_apple_subscription").put("linkedAccounts",new JSONArray()).put("expiresOn","").put("note",""));
    } else if(action.equals("goal-edit")) {
      JSONObject goal=LedgerStore.copy(store.snapshot().getJSONObject("state").getJSONArray("goals").getJSONObject(0));goal.put("saved",35000);store.saveGoal(goal);
    } else if(action.equals("delete-sub")) {
      store.deleteSubscription("mobile_sub");
    } else if(action.equals("offline-first")) {
      store.saveAccount(new JSONObject().put("id","offline_wallet").put("name","离线账户").put("type","现金").put("color","#778899").put("openingBalance",10000));
      store.saveManual(new JSONObject().put("id","offline_expense").put("type","expense").put("amount",420).put("accountId","offline_wallet").put("title","首次配对前买菜").put("category","餐饮美食").put("note","").put("date",LedgerStore.today()));
    } else if(action.equals("add")||action.equals("add-large")) {
      int count=Integer.parseInt(args[4]);
      String prefix=UUID.randomUUID().toString();
      char[] chars=new char[2000];java.util.Arrays.fill(chars,'注');String note=action.equals("add-large")?new String(chars):"";
      for(int i=0;i<count;i++)store.putTransaction(new JSONObject().put("id","jdk_"+prefix+"_"+i).put("type","expense").put("amount",100+i).put("accountId","wallet").put("category","餐饮美食").put("title",(action.equals("add-large")?"长备注测试":"Java离线账单")+i).put("date",LedgerStore.today()).put("note",note).put("currency","CNY"),null);
    } else if(action.equals("edit-large")) {
      JSONArray transactions=store.snapshot().getJSONObject("state").getJSONArray("transactions");
      for(int i=0;i<transactions.length();i++){JSONObject tx=LedgerStore.copy(transactions.getJSONObject(i));if(tx.getString("title").startsWith("长备注测试")){tx.put("title",tx.getString("title")+"修改");store.putTransaction(tx,null);}}
    } else if(action.equals("edit")) {
      JSONObject tx=LedgerStore.copy(store.snapshot().getJSONObject("state").getJSONArray("transactions").getJSONObject(0));
      tx.put("title","手机离线修改");store.putTransaction(tx,null);output.put("transaction",tx);
    } else if(action.equals("delete-pending")) {
      JSONArray operations=store.snapshot().getJSONArray("operations");check(operations.length()==1,"Expected one pending creation");
      String id=operations.getJSONObject(0).getJSONObject("transaction").getString("id");
      store.deleteTransaction(id);output.put("deletedId",id);
    } else if(action.equals("resolve-desktop")) {
      JSONArray conflicts=store.snapshot().getJSONArray("conflicts");check(conflicts.length()>0,"Expected unresolved conflict");
      store.resolveConflict(conflicts.getJSONObject(0).getString("operationId"),false);
    } else if(action.equals("sync")||action.equals("sync-no-ack")||action.equals("sync-until-settled")) {
      String qr=new String(Files.readAllBytes(Paths.get(args[2])),StandardCharsets.UTF_8);
      SyncClient.Pairing pairing=SyncClient.parsePairing(qr);
      int rounds=0;
      do {
        JSONObject request=store.syncRequest(UUID.randomUUID().toString());
        JSONObject response=SyncClient.synchronize(pairing,request);
        output.put("request",request).put("response",response);
        if(!action.equals("sync-no-ack"))store.applyResponse(response,request);
        rounds++;
      }while(action.equals("sync-until-settled")&&rounds<20&&store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").length()>0);
      output.put("rounds",rounds);
    } else if(action.equals("pairing-validation")) {
      JSONObject value=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),StandardCharsets.UTF_8));
      String[] invalid={"http://8.8.8.8:12345","http://127.0.0.1:12345","http://localhost:12345","http://192.168.001.1:12345","http://192.168.1.1:80","http://192.168.1.1:12345/path","https://192.168.1.1:12345"};
      for(String endpoint:invalid){value.put("addresses",new JSONArray().put(endpoint));boolean rejected=false;try{SyncClient.parsePairing(value.toString());}catch(Exception expected){rejected=true;}check(rejected,"Unsafe pairing accepted: "+endpoint);}
      JSONObject old=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),StandardCharsets.UTF_8));old.remove("protocolVersion");boolean oldRejected=false;try{SyncClient.parsePairing(old.toString());}catch(Exception expected){oldRejected=true;}check(oldRejected,"Old desktop QR must not accept full entity queue");
      old.put("protocolVersion",99);boolean futureRejected=false;try{SyncClient.parsePairing(old.toString());}catch(Exception expected){futureRejected=true;}check(futureRejected,"Unknown future protocol rejected");
      output.put("rejected",invalid.length+2);
    } else throw new IllegalArgumentException("Unknown action");
    output.put("snapshot",store.snapshot());
    Files.write(Paths.get(args[3]),output.toString().getBytes(StandardCharsets.UTF_8));
    System.out.println("Actual Android Java source test passed: "+action);
  }
}
