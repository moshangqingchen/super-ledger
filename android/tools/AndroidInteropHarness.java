import android.content.Context;
import com.moneylab.superledger.mobile.LedgerStore;
import com.moneylab.superledger.mobile.SyncClient;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.UUID;

/** Uses production SyncClient + LedgerStore; only Android platform types are adapted. */
public class AndroidInteropHarness {
  private static void check(boolean pass,String message) { if(!pass)throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    String action=args[0];
    LedgerStore store=LedgerStore.get(new Context(new File(args[1])));
    JSONObject output=new JSONObject();
    if(action.equals("full-ledger")) {
      store.saveAccount(new JSONObject().put("id","mobile_usd").put("name","手机美元账户").put("type","银行卡").put("color","#778899").put("currency","USD").put("cnyRate","7.2").put("rateMode","manual").put("openingBalance",10000));
      store.saveManual(new JSONObject().put("id","mobile_foreign_expense").put("type","expense").put("amount",1250).put("accountId","mobile_usd").put("currency","USD").put("cnyRate","7.1").put("title","美元消费").put("category","日用购物").put("note","").put("date",LedgerStore.today()));
      store.saveManual(new JSONObject().put("id","mobile_exchange").put("type","transfer").put("amount",7200).put("accountId","wallet").put("toAccountId","mobile_usd").put("toAmount",1000).put("currency","CNY").put("toCurrency","USD").put("title","账户换汇").put("category","账户转账").put("note","").put("date",LedgerStore.today()));
      store.saveGoal(new JSONObject().put("id","mobile_goal").put("name","手机储蓄心愿").put("target",500000).put("saved",25000).put("color","#778899"));
      store.saveSettings(new JSONObject().put("monthlyBudget",123456).put("currency","CNY"));
      store.saveSubscription(new JSONObject().put("id","mobile_sub").put("name","手机订阅").put("amount",500).put("currency","CNY").put("accountId","wallet").put("category","会员订阅").put("startDate",LedgerStore.today()).put("billingDay",Integer.parseInt(LedgerStore.today().substring(8))).put("active",true).put("recurring",true).put("icon","repeat").put("color","#778899").put("processedOccurrences",new JSONArray()));
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
    } else if(action.equals("sync")||action.equals("sync-no-ack")) {
      String qr=new String(Files.readAllBytes(Paths.get(args[2])),StandardCharsets.UTF_8);
      SyncClient.Pairing pairing=SyncClient.parsePairing(qr);
      JSONObject request=store.syncRequest(UUID.randomUUID().toString());
      JSONObject response=SyncClient.synchronize(pairing,request);
      output.put("request",request).put("response",response);
      if(action.equals("sync"))store.applyResponse(response,request);
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
