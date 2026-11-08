package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.TimeZone;

/** The chart reads deadlines and exact next-charge coverage without booking or changing the ledger. */
public final class SubscriptionOverviewTest {
    private static int checks;
    private static final long NOW=Instant.parse("2026-11-07T01:30:00Z").toEpochMilli();
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static JSONObject subscription(String id,long fee,String start)throws Exception {
        return MobileLedgerTest.subscription(id,"wallet",fee,start,true).put("billingDay",7).put("startHour",8).put("billingHour",8);
    }
    private static JSONObject state()throws Exception {
        JSONObject state=MobileLedger.emptyState().put("schemaVersion",3);
        state.getJSONArray("accounts").put(MobileLedgerTest.account("wallet","CNY",100,null));
        state.getJSONArray("subscriptions").put(subscription("soon",60,"2026-11-07").put("startHour",10).put("expiresOn","2026-11-12"))
            .put(subscription("late",60,"2026-08-01").put("expiresOn","2026-11-06"));
        return state;
    }
    public static void main(String[] args)throws Exception {
        JSONObject state=state();String before=state.toString();JSONObject overview=SubscriptionOverview.build(state,NOW);
        check(state.toString().equals(before),"overview leaves all ledger values and processed history unchanged");
        check(overview.getString("today").equals("2026-11-07")&&overview.getInt("hour")==9,"overview uses the Beijing date and hour");
        JSONObject first=overview.getJSONArray("rows").getJSONObject(0),second=overview.getJSONArray("rows").getJSONObject(1),stats=overview.getJSONObject("stats");
        check(first.getJSONObject("expiry").getString("source").equals("expiry")&&first.getJSONObject("expiry").getLong("days")==5,"explicit membership expiry remains separate from the next charge");
        check(!first.getBoolean("pending")&&first.getInt("dueHour")==10,"today's future scheduled hour is not already pending");
        check(second.getBoolean("pending")&&second.getString("due").equals("2026-08-01"),"the earliest unpaid old period remains pending");
        check(stats.getInt("upcoming")==1&&stats.getInt("urgent")==1&&stats.getInt("expired")==1&&stats.getInt("pending")==1,"expiry and charge reminders are counted independently");
        check(stats.getInt("shortfall")==0,"both individual fees can fit even when their shared total cannot");
        JSONObject funding=overview.getJSONArray("accounts").getJSONObject(0);
        check(overview.getJSONArray("accounts").length()==1&&funding.getLong("balance")==100,"a shared account balance is counted once");
        check(funding.getLong("amount")==120&&funding.getLong("shortfall")==20&&funding.getJSONArray("subscriptions").length()==2,"coverage combines exactly one next fee per enabled plan");
        check(Math.abs(funding.getDouble("coverage")-100.0/120)<0.000001,"coverage is derived from the shared total");
        check(funding.getString("due").equals("2026-08-01")&&funding.getInt("dueHour")==8,"account reminders retain the earliest date and its hour");

        JSONObject lifecycle=state();
        lifecycle.getJSONArray("subscriptions").put(subscription("paused",900,"2026-11-07").put("active",false).put("expiresOn","2026-11-07"))
            .put(subscription("done",900,"2026-11-07").put("recurring",false).put("processedOccurrences",new JSONArray().put("done:2026-11")))
            .put(subscription("once",20,"2026-11-07").put("recurring",false));
        JSONObject life=SubscriptionOverview.build(lifecycle,NOW);
        check(life.getJSONArray("accounts").getJSONObject(0).getLong("amount")==140,"paused and completed single plans add no next charge");
        check(!life.getJSONArray("rows").getJSONObject(2).getBoolean("canBook")&&!life.getJSONArray("rows").getJSONObject(3).getBoolean("canBook"),"inactive plans and completed one-off payments remain distinguishable rows");
        JSONObject single=life.getJSONArray("rows").getJSONObject(4);
        check(single.getBoolean("pending")&&single.getJSONObject("expiry").getString("source").equals("none"),"an unfinished single payment can be pending without an invented membership date");
        check(SubscriptionOverview.radarDate(single)==null&&!single.isNull("due"),"an unfinished single payment without membership expiry stays undated on the radar while retaining its separate next booking date");
        check(SubscriptionOverview.radarDays(second,overview.getString("today"))==-1,"expired membership dates stay outside the in-range radar instead of being clamped to an orbit");
        check(life.getJSONArray("rows").getJSONObject(2).getJSONObject("expiry").getString("source").equals("expiry"),"pausing bookkeeping preserves an explicit membership deadline");
        check(SubscriptionOverview.radarDays(life.getJSONArray("rows").getJSONObject(2),"2026-11-07")==0,"a paused plan retains its real membership date on the radar");
        check(life.getJSONObject("stats").getInt("upcoming")==2&&life.getJSONObject("stats").getInt("urgent")==2,"paused membership deadlines remain in the same date counts as the radar");

        JSONObject renewal=state();renewal.getJSONArray("subscriptions").getJSONObject(0).remove("expiresOn");
        check(SubscriptionOverview.build(renewal,NOW).getJSONArray("rows").getJSONObject(0).getJSONObject("expiry").getString("source").equals("renewal"),"unfilled membership dates use a clearly identified renewal reminder");
        JSONObject futureIncome=state();futureIncome.getJSONArray("transactions").put(MobileLedgerTest.tx("future","income","wallet",9999,"2026-11-08"));
        check(SubscriptionOverview.build(futureIncome,NOW).getJSONArray("accounts").getJSONObject(0).getLong("balance")==100,"future income is excluded from today's funding coverage");
        JSONObject debt=state();debt.getJSONArray("accounts").getJSONObject(0).put("openingBalance",-100);
        JSONObject debtGroup=SubscriptionOverview.build(debt,NOW).getJSONArray("accounts").getJSONObject(0);
        check(debtGroup.getLong("shortfall")==220&&debtGroup.getDouble("coverage")==0,"negative balances include the debt in the exact funding gap");

        JSONObject currencies=state();currencies.getJSONArray("accounts").put(MobileLedgerTest.account("token","USDT",1000000,"7.2")).put(MobileLedgerTest.account("yen","JPY",99,"0.05"));
        currencies.getJSONArray("subscriptions").put(subscription("micro",1000001,"2026-11-07").put("accountId","token").put("currency","USDT"))
            .put(subscription("yenfee",100,"2026-11-07").put("accountId","yen").put("currency","JPY"));
        JSONObject fx=SubscriptionOverview.build(currencies,NOW);
        check(fx.getJSONArray("accounts").getJSONObject(1).getLong("shortfall")==1&&fx.getJSONArray("accounts").getJSONObject(2).getLong("shortfall")==1,"USDT micro-units and whole yen retain exact native funding gaps");
        check(fx.getJSONArray("totals").length()==3&&fx.getJSONArray("totals").getJSONObject(1).getString("currency").equals("USDT"),"currency totals stay separate instead of mixing native units");
        JSONObject large=MobileLedger.emptyState();large.getJSONArray("accounts").put(MobileLedgerTest.account("wallet","CNY",0,null));
        large.getJSONArray("subscriptions").put(MobileLedgerTest.subscription("large1","wallet",MobileLedger.MAX_MONEY,"2026-11-07",false))
            .put(MobileLedgerTest.subscription("large2","wallet",MobileLedger.MAX_MONEY,"2026-11-07",false));
        MobileLedger.validateState(large);
        check(SubscriptionOverview.build(large,NOW).getJSONArray("accounts").getJSONObject(0).getLong("amount")==2*MobileLedger.MAX_MONEY,"shared next-fee totals may exceed a single record's allowed amount without losing digits");

        TimeZone original=TimeZone.getDefault();
        try{
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"));
            long midnight=Instant.parse("2026-11-06T16:00:00Z").toEpochMilli();
            JSONObject boundary=state();boundary.getJSONArray("subscriptions").getJSONObject(0).put("startHour",0);
            check(SubscriptionOverview.build(boundary,midnight).getJSONArray("rows").getJSONObject(0).getBoolean("pending"),"Beijing midnight is due even when the device timezone is on the previous day");
            check(!SubscriptionOverview.build(boundary,midnight-1).getJSONArray("rows").getJSONObject(0).getBoolean("pending"),"a charge remains future just before its Beijing day begins");
        }finally{TimeZone.setDefault(original);}
        JSONObject empty=SubscriptionOverview.build(MobileLedger.emptyState(),NOW);
        check(empty.getJSONArray("rows").length()==0&&empty.getJSONArray("accounts").length()==0&&empty.getJSONObject("stats").getInt("pending")==0,"an empty ledger has an empty overview with zero alerts");
        JSONObject outside=state();outside.getJSONArray("subscriptions").getJSONObject(0).put("expiresOn","2027-01-01");
        check(SubscriptionOverview.radarDays(SubscriptionOverview.build(outside,NOW).getJSONArray("rows").getJSONObject(0),"2026-11-07")>30,"distant membership dates retain their real distance instead of becoming a 30-day star");
        check(SubscriptionOverview.radarDate(life.getJSONArray("rows").getJSONObject(3))==null,"a completed single payment without membership expiry has no invented radar date");
        System.out.println("SubscriptionOverview: "+checks+" deadline and native funding checks passed");
    }
}
