package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Exact-money and desktop-compatible accounting regression tests, without Android runtime. */
public final class MobileLedgerTest {
    private static int checks;
    private interface Work {void run() throws Exception;}
    private static void check(boolean test,String label){checks++;if(!test)throw new AssertionError(label);}
    private static void rejects(Work work,String label)throws Exception{try{work.run();throw new AssertionError(label);}catch(AssertionError e){throw e;}catch(Exception expected){checks++;}}
    static JSONObject account(String id,String currency,long opening,String rate)throws Exception{JSONObject a=new JSONObject().put("id",id).put("name",id).put("type","银行账户").put("color","#89abcd").put("currency",currency).put("openingBalance",opening);if(!currency.equals("CNY"))a.put("cnyRate",rate).put("rateMode","manual");return a;}
    static JSONObject tx(String id,String type,String account,long amount,String date)throws Exception{return new JSONObject().put("id",id).put("type",type).put("accountId",account).put("amount",amount).put("date",date).put("title",id).put("category",type.equals("income")?"其他收入":"其他支出").put("note","");}
    static JSONObject subscription(String id,String account,long amount,String start,boolean recurring)throws Exception{return new JSONObject().put("id",id).put("name","测试会员").put("accountId",account).put("amount",amount).put("currency","CNY").put("category","会员订阅").put("startDate",start).put("billingDay",31).put("recurring",recurring).put("active",true).put("color","#89abcd").put("icon","repeat").put("processedOccurrences",new JSONArray());}
    public static void main(String[] args)throws Exception{
        check(MobileLedger.currencyCodes().length==12,"all desktop currencies available");
        check(MobileLedger.parseMoney("1.000001","USDT")==1000001,"USDT preserves micro units");
        check(MobileLedger.parseMoney("100","JPY")==100,"JPY integer denomination");
        check(MobileLedger.parseMoney("-0.01","CNY")==-1,"negative opening exact");
        rejects(()->MobileLedger.parseMoney("1.1","JPY"),"JPY fractional input rejected");
        rejects(()->MobileLedger.parseMoney("0.0000001","USDT"),"excess precision rejected");
        rejects(()->MobileLedger.parseMoney("1e2","USD"),"scientific notation rejected");
        rejects(()->MobileLedger.parseMoney("10000000000.01","CNY"),"native range enforced");
        check(MobileLedger.normalizeRate("007.12000000").equals("7.12"),"normalized exact rate");
        rejects(()->MobileLedger.normalizeRate("0"),"zero rate rejected");
        rejects(()->MobileLedger.normalizeRate("1.000000001"),"rate precision enforced");
        check(MobileLedger.toCnyCents(1,"JPY","0.005")==1&&MobileLedger.toCnyCents(-1,"JPY","0.005")==-1,"half away from zero");
        check(MobileLedger.toCnyCents(1000001,"USDT","7.12345678")==712,"USDT conversion uses exact rational arithmetic");
        check(MobileLedger.amountInput(1000001,"USDT").equals("1.000001"),"editable precision preserved");
        check(MobileLedger.formatMoney(123456,"CNY").equals("¥ 1,234.56"),"native formatting");
        JSONObject state=MobileLedger.emptyState().put("schemaVersion",2);state.getJSONArray("accounts").put(account("bank","CNY",100000,null)).put(account("usd","USD",10000,"7.2"));state.getJSONObject("settings").put("monthlyBudget",10000);
        JSONObject expense=tx("meal","expense","usd",1250,"2026-11-05").put("currency","USD").put("cnyRate","7.1");state.getJSONArray("transactions").put(expense).put(tx("move","transfer","bank",7200,"2026-11-05").put("toAccountId","usd").put("toCurrency","USD").put("toAmount",1000)).put(tx("future","income","bank",9999,"2026-11-06"));MobileLedger.validateState(state);
        JSONObject balance=MobileLedger.balances(state,"2026-11-05");check(balance.getLong("bank")==92800&&balance.getLong("usd")==9750,"transfer touches both native balances and excludes future");
        check(MobileLedger.netWorth(state,"2026-11-05")==163000,"assets use current account rates");
        JSONObject summary=MobileLedger.monthlySummary(state,"2026-11","2026-11-05");check(summary.getLong("income")==0&&summary.getLong("expense")==8875&&summary.getLong("remaining")==1125,"reports use historical snapshot and exclude transfer/future");
        state.getJSONArray("accounts").getJSONObject(1).put("cnyRate","8");check(MobileLedger.transactionCnyAmount(expense)==8875,"account rate change never rewrites past expense");
        check(MobileLedger.dailySummary(state,"2026-11-05").getLong("expense")==8875,"daily report uses same exact rules");
        JSONObject invalid=MobileLedger.copy(state);invalid.getJSONArray("transactions").getJSONObject(1).remove("toAmount");rejects(()->MobileLedger.validateState(invalid),"cross-currency requires actual received amount");
        JSONObject duplicate=MobileLedger.copy(state);duplicate.getJSONArray("accounts").put(account("bank","CNY",0,null));rejects(()->MobileLedger.validateState(duplicate),"duplicate entity IDs rejected");
        check(MobileLedger.addMonthsDue("2024-01-31",1,31).equals("2024-02-29"),"leap-year month-end clamp");check(MobileLedger.addMonthsDue("2025-01-31",1,31).equals("2025-02-28"),"ordinary month-end clamp");check(MobileLedger.addMonthsDue("2025-01-10",0,31).equals("2025-01-10"),"first charge uses start date");
        JSONObject recurring=MobileLedger.emptyState();recurring.getJSONArray("accounts").put(account("bank","CNY",0,null));recurring.getJSONArray("subscriptions").put(subscription("monthly","bank",2500,"2026-08-31",true)).put(subscription("once","bank",9900,"2026-09-15",false));
        JSONObject applied=MobileLedger.applyRecurring(recurring,"2026-11-05");check(applied.getJSONArray("added").length()==4,"catch up monthly and single charge once");JSONObject next=applied.getJSONObject("state");check(MobileLedger.find(next.getJSONArray("transactions"),"rec_monthly_202609").getString("date").equals("2026-09-30"),"desktop-compatible deterministic recurring ID and date");check(MobileLedger.applyRecurring(next,"2026-11-05").getJSONArray("added").length()==0,"repeated recurrence idempotent");
        next.getJSONArray("transactions").remove(0);check(MobileLedger.applyRecurring(next,"2026-11-05").getJSONArray("added").length()==0,"deleted paid occurrence is not recreated");
        JSONObject paused=subscription("pause","bank",100,"2026-01-31",true).put("active",false);JSONObject resumed=MobileLedger.setSubscriptionActive(paused,true,"2026-03-31");check(resumed.getJSONArray("processedOccurrences").length()==2,"resume intentionally skips earlier paused months");check(MobileLedger.nextSubscriptionDue(resumed,"2026-03-31").equals("2026-03-31"),"resume today keeps today due");
        JSONObject corrupted=MobileLedger.copy(next);corrupted.getJSONObject("settings").put("monthlyBudget",1.5);rejects(()->MobileLedger.validateState(corrupted),"fractional minor units rejected");
        System.out.println("MobileLedger: "+checks+" financial checks passed");
    }
}
