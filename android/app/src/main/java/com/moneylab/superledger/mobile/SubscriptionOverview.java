package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.ZonedDateTime;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;

/** Read-only membership deadlines and one next native-currency charge per enabled plan. */
public final class SubscriptionOverview {
    private SubscriptionOverview() {}

    public static String radarDate(JSONObject row)throws Exception {
        JSONObject expiry=row.getJSONObject("expiry");
        return expiry.isNull("date")?null:expiry.getString("date");
    }
    public static Long radarDays(JSONObject row,String today)throws Exception {
        String date=radarDate(row);return date==null?null:LocalDate.parse(date).toEpochDay()-LocalDate.parse(today).toEpochDay();
    }

    public static JSONObject build(JSONObject state,long nowMillis)throws Exception {
        ZonedDateTime now=MobileLedger.beijingDateTime(nowMillis);
        String today=now.toLocalDate().toString();
        JSONObject balances=MobileLedger.balances(state,today);
        JSONArray accounts=state.getJSONArray("accounts"),subscriptions=state.getJSONArray("subscriptions"),rows=new JSONArray();
        Map<String,JSONObject> accountById=new LinkedHashMap<>(),groups=new LinkedHashMap<>();
        Map<String,Long> totals=new LinkedHashMap<>();
        for(int i=0;i<accounts.length();i++){JSONObject account=accounts.getJSONObject(i);accountById.put(account.getString("id"),account);}
        JSONObject stats=new JSONObject().put("upcoming",0).put("urgent",0).put("expired",0).put("pending",0).put("shortfall",0);
        for(int i=0;i<subscriptions.length();i++){
            JSONObject sub=subscriptions.getJSONObject(i);
            String accountId=sub.getString("accountId");JSONObject account=accountById.get(accountId);
            if(account==null)throw new Exception("订阅扣款账户不存在");
            String currency=MobileLedger.currency(account);long balance=balances.getLong(accountId);
            SubscriptionDetails.Status status=SubscriptionDetails.expiryStatus(sub,today);
            String due=MobileLedger.nextSubscriptionDue(sub,today);
            int dueHour=due==null?0:MobileLedger.subscriptionDueHour(sub,due);
            boolean canBook=sub.getBoolean("active")&&due!=null;
            boolean pending=canBook&&(due.compareTo(today)<0||due.equals(today)&&dueHour<=now.getHour());
            JSONObject expiry=new JSONObject().put("tone",status.tone).put("label",status.label).put("detail",status.detail)
                .put("date",status.date==null?JSONObject.NULL:status.date).put("days",status.days==null?JSONObject.NULL:status.days).put("source",status.source);
            JSONObject row=new JSONObject().put("sub",sub).put("expiry",expiry).put("due",due==null?JSONObject.NULL:due)
                .put("dueHour",due==null?JSONObject.NULL:dueHour).put("pending",pending).put("accountId",accountId).put("currency",currency)
                .put("balance",balance).put("shortfall",canBook?Math.max(0,sub.getLong("amount")-balance):0).put("canBook",canBook);
            rows.put(row);
            if(status.days!=null){
                if(status.days>=0&&status.days<=30)stats.put("upcoming",stats.getInt("upcoming")+1);
                if(status.days>=0&&status.days<=7)stats.put("urgent",stats.getInt("urgent")+1);
                if(status.days<0)stats.put("expired",stats.getInt("expired")+1);
            }
            if(pending)stats.put("pending",stats.getInt("pending")+1);
            if(row.getLong("shortfall")>0)stats.put("shortfall",stats.getInt("shortfall")+1);
            if(!canBook)continue;
            JSONObject group=groups.get(accountId);
            if(group==null){
                group=new JSONObject().put("account",account).put("accountId",accountId).put("currency",currency).put("balance",balance)
                    .put("amount",0L).put("subscriptions",new JSONArray()).put("due",due).put("dueHour",dueHour);
                groups.put(accountId,group);
            }
            group.put("amount",Math.addExact(group.getLong("amount"),sub.getLong("amount")));
            group.getJSONArray("subscriptions").put(row);
            if(due.compareTo(group.getString("due"))<0||due.equals(group.getString("due"))&&dueHour<group.getInt("dueHour"))group.put("due",due).put("dueHour",dueHour);
            totals.put(currency,Math.addExact(totals.containsKey(currency)?totals.get(currency):0L,sub.getLong("amount")));
        }
        JSONArray funding=new JSONArray(),currencyTotals=new JSONArray();
        for(JSONObject group:groups.values()){
            long required=group.getLong("amount"),balance=group.getLong("balance");
            group.put("shortfall",Math.max(0,required-balance)).put("coverage",Math.max(0,Math.min(1,(double)balance/required)));
            funding.put(group);
        }
        for(Map.Entry<String,Long> total:totals.entrySet())currencyTotals.put(new JSONObject().put("currency",total.getKey()).put("amount",total.getValue()));
        return new JSONObject().put("today",today).put("hour",now.getHour()).put("rows",rows).put("stats",stats).put("accounts",funding).put("totals",currencyTotals);
    }
}
