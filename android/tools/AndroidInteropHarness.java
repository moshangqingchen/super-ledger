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
    if(action.equals("add")||action.equals("add-large")) {
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
      output.put("rejected",invalid.length);
    } else throw new IllegalArgumentException("Unknown action");
    output.put("snapshot",store.snapshot());
    Files.write(Paths.get(args[3]),output.toString().getBytes(StandardCharsets.UTF_8));
    System.out.println("Actual Android Java source test passed: "+action);
  }
}
