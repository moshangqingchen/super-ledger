package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.LocalDate;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.YearMonth;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Pure, exact ledger rules shared by the mobile UI and durable store. No network or Android APIs. */
public final class MobileLedger {
    private MobileLedger() {}
    public static final long MAX_MONEY = 1_000_000_000_000L;
    private static final BigInteger LIMIT = BigInteger.valueOf(MAX_MONEY), RATE_SCALE = BigInteger.valueOf(100_000_000L);
    private static final String[] CODES = {"CNY","USD","USDT","JPY","EUR","HKD","GBP","KRW","SGD","AUD","CAD","CHF","TRY"};
    public static String[] currencyCodes() { return CODES.clone(); }
    public static ZonedDateTime beijingDateTime(long millis) { return Instant.ofEpochMilli(millis).atZone(ZoneOffset.ofHours(8)); }
    public static int decimals(String code) throws Exception {
        for (String item : CODES) if (item.equals(code)) return code.equals("USDT") ? 6 : code.equals("JPY") || code.equals("KRW") ? 0 : 2;
        throw new Exception("请选择支持的账户币种");
    }
    public static String currency(JSONObject record) throws Exception { String code = record.has("currency") ? record.getString("currency") : "CNY"; decimals(code); return code; }
    public static long parseMoney(String value, String code) throws Exception {
        int precision = decimals(code); String raw = value == null ? "" : value.trim();
        if (!raw.matches(precision == 0 ? "-?[0-9]+" : "-?[0-9]+(?:\\.[0-9]{1," + precision + "})?")) throw new Exception(code + (precision == 0 ? "金额请填写整数" : "金额最多保留 " + precision + " 位小数"));
        try { return bounded(new BigDecimal(raw).movePointRight(precision).toBigIntegerExact(), "金额"); }
        catch (ArithmeticException e) { throw new Exception("金额超过支持的范围"); }
    }
    public static String amountInput(long units, String code) throws Exception {
        bounded(BigInteger.valueOf(units), "金额"); return new BigDecimal(BigInteger.valueOf(units), decimals(code)).stripTrailingZeros().toPlainString();
    }
    public static String formatMoney(long units, String code) throws Exception {
        bounded(BigInteger.valueOf(units), "金额"); int precision = decimals(code);
        String raw = new BigDecimal(BigInteger.valueOf(units), precision).toPlainString();
        if (code.equals("USDT")) raw = amountInput(units, code);
        String[] parts = raw.split("\\."); parts[0] = parts[0].replaceAll("(?<=\\d)(?=(\\d{3})+$)", ",");
        return (code.equals("CNY") ? "¥" : code) + " " + parts[0] + (parts.length == 2 ? "." + parts[1] : "");
    }
    private static BigInteger rateUnits(String value) throws Exception {
        if (value == null || value.length() > 32 || !value.trim().matches("[0-9]+(?:\\.[0-9]{1,8})?")) throw new Exception("汇率须大于 0，最多 8 位小数");
        BigInteger exact = new BigDecimal(value.trim()).movePointRight(8).toBigIntegerExact();
        if (exact.signum() <= 0 || exact.compareTo(RATE_SCALE.multiply(BigInteger.valueOf(1_000_000L))) > 0) throw new Exception("汇率须大于 0 且不超过 1000000");
        return exact;
    }
    public static String normalizeRate(String value) throws Exception { return new BigDecimal(rateUnits(value), 8).stripTrailingZeros().toPlainString(); }
    public static String currencyRate(JSONObject account) throws Exception {
        String code = currency(account);
        if (code.equals("CNY")) { if (account.has("cnyRate") && !normalizeRate(account.getString("cnyRate")).equals("1")) throw new Exception("人民币汇率必须为 1"); return "1"; }
        if (!account.has("cnyRate")) throw new Exception(code + "账户需要填写人民币折算汇率");
        return normalizeRate(account.getString("cnyRate"));
    }
    public static long toCnyCents(long units, String code, String rate) throws Exception {
        bounded(BigInteger.valueOf(units), "原币金额"); int precision = decimals(code);
        if (code.equals("CNY")) { if (rate != null && !normalizeRate(rate).equals("1")) throw new Exception("人民币汇率必须为 1"); rate = "1"; }
        BigInteger numerator = BigInteger.valueOf(units).multiply(rateUnits(rate)).multiply(BigInteger.valueOf(100));
        BigInteger denominator = BigInteger.TEN.pow(precision).multiply(RATE_SCALE);
        BigInteger result = numerator.abs().add(denominator.divide(BigInteger.valueOf(2))).divide(denominator);
        return bounded(numerator.signum() < 0 ? result.negate() : result, "人民币折算金额");
    }
    public static long transactionCnyAmount(JSONObject tx) throws Exception { return toCnyCents(integer(tx, "amount", 1, MAX_MONEY), currency(tx), tx.has("cnyRate") ? tx.getString("cnyRate") : null); }
    private static long bounded(BigInteger value, String label) throws Exception { if (value.abs().compareTo(LIMIT) > 0) throw new Exception(label + "超过支持的范围"); return value.longValue(); }
    private static long integer(JSONObject obj, String key, long min, long max) throws Exception {
        Object value = obj.opt(key); if (!(value instanceof Number)) throw new Exception(key + "必须是整数");
        try { long exact = new BigDecimal(value.toString()).longValueExact(); if (exact < min || exact > max) throw new ArithmeticException(); return exact; }
        catch (Exception e) { throw new Exception(key + "超过整数支持范围"); }
    }
    private static String text(JSONObject obj, String key, int max, boolean empty) throws Exception {
        Object value = obj.opt(key); if (!(value instanceof String)) throw new Exception(key + "必须是文字"); String s = (String) value;
        if (s.length() > max || !empty && s.matches("[\\x09-\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*") || s.matches("(?s).*[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F].*")) throw new Exception(key + "格式不正确"); return s;
    }
    private static void id(JSONObject obj, String key, int max) throws Exception { if (!text(obj,key,max,false).matches("[A-Za-z0-9_-]+")) throw new Exception(key + "标识不正确"); }
    private static void bool(JSONObject obj, String key) throws Exception { if (!(obj.opt(key) instanceof Boolean)) throw new Exception(key + "必须是开关值"); }
    private static void color(JSONObject obj) throws Exception { if (!text(obj,"color",9,false).matches("#[A-Fa-f0-9]{3}(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{5})?")) throw new Exception("颜色格式不正确"); }
    public static boolean isValidDate(String value) { try { if (value == null || !value.matches("(?:19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}")) return false; return LocalDate.parse(value).toString().equals(value); } catch (Exception e) { return false; } }
    private static void date(String value) throws Exception { if (!isValidDate(value)) throw new Exception("日期必须为 1900 至 2199 年的有效 YYYY-MM-DD"); }
    private static JSONArray array(JSONObject state, String key, int max) throws Exception { JSONArray result = state.optJSONArray(key); if (result == null || result.length() > max) throw new Exception(key + "列表无效或超过容量上限"); return result; }
    public static JSONObject find(JSONArray values, String id) { if (values == null) return null; for(int i=0;i<values.length();i++) { JSONObject item=values.optJSONObject(i); if(item!=null && id.equals(item.optString("id")))return item; } return null; }
    public static JSONObject copy(JSONObject obj) throws Exception { return new JSONObject(obj.toString()); }
    public static JSONObject merge(JSONObject old, JSONObject input) throws Exception { JSONObject result = old == null ? new JSONObject() : copy(old); Iterator<String> keys=input.keys(); while(keys.hasNext()){String key=keys.next();result.put(key,input.get(key));} return result; }
    private static Set<String> unique(JSONArray values, int max) throws Exception { Set<String> result=new HashSet<>(); for(int i=0;i<values.length();i++){JSONObject item=values.getJSONObject(i);id(item,"id",max);if(!result.add(item.getString("id")))throw new Exception("记录 ID 重复");}return result; }
    public static JSONObject emptyState() throws Exception { return new JSONObject().put("schemaVersion",1).put("revision",0).put("demo",false).put("settings",new JSONObject().put("monthlyBudget",0).put("currency","CNY")).put("accounts",new JSONArray()).put("transactions",new JSONArray()).put("subscriptions",new JSONArray()).put("goals",new JSONArray()); }
    /** Only old mobile empty states omitted these top-level fields; existing values are never replaced. */
    public static JSONObject upgradeLegacyState(JSONObject source) throws Exception {
        JSONObject state=copy(source),empty=emptyState(); Iterator<String> keys=empty.keys();while(keys.hasNext()){String key=keys.next();if(!state.has(key))state.put(key,empty.get(key));} return state;
    }
    public static void validateState(JSONObject state) throws Exception {
        long schema=integer(state,"schemaVersion",1,4);integer(state,"revision",0,9_007_199_254_740_991L);bool(state,"demo");JSONObject settings=state.getJSONObject("settings");integer(settings,"monthlyBudget",0,MAX_MONEY);if(!"CNY".equals(settings.optString("currency")))throw new Exception("汇总币种必须为 CNY");
        if(settings.has("categoryBudgets")||settings.has("customCategories"))requireSchema4(schema);
        if(settings.has("categoryBudgets")){
            JSONObject budgets=settings.optJSONObject("categoryBudgets");if(budgets==null||budgets.length()>50)throw new Exception("分类预算必须是对象且不能超过50项");
            Iterator<String> keys=budgets.keys();while(keys.hasNext()){String key=keys.next();text(new JSONObject().put("category",key),"category",50,false);integer(budgets,key,1,MAX_MONEY);}
        }
        if(settings.has("customCategories")){
            JSONObject custom=settings.optJSONObject("customCategories");if(custom==null||custom.length()!=2)throw new Exception("自定义分类需要支出和收入两组");
            Set<String> builtin=new HashSet<>();java.util.Collections.addAll(builtin,LedgerCategories.EXPENSE);java.util.Collections.addAll(builtin,LedgerCategories.INCOME);
            for(String kind:new String[]{"expense","income"}){JSONArray values=array(custom,kind,30);Set<String> names=new HashSet<>();for(int i=0;i<values.length();i++){String name=text(new JSONObject().put("category",values.get(i)),"category",50,false);if(builtin.contains(name)||!names.add(name))throw new Exception("自定义分类不能重复或与内置分类重名");}}
        }
        JSONArray accounts=array(state,"accounts",100),transactions=array(state,"transactions",100000),subs=array(state,"subscriptions",1000),goals=array(state,"goals",1000);
        Set<String> accountIds=unique(accounts,80),subIds=unique(subs,80);unique(transactions,128);unique(goals,80);
        for(int i=0;i<accounts.length();i++) { JSONObject a=accounts.getJSONObject(i);text(a,"name",60,false);text(a,"type",40,false);color(a);integer(a,"openingBalance",-MAX_MONEY,MAX_MONEY);String c=currency(a);currencyRate(a);
            if(schema==1&&!c.equals("CNY"))throw new Exception("外币账本需要 schemaVersion 2");
            for(String field:new String[]{"providerId","bankId"})if(a.has(field))id(a,field,80);
            AppleBalance.validateAccount(a);
            if(a.has("lastFour")&&!text(a,"lastFour",4,false).matches("[0-9]{4}"))throw new Exception("卡片尾号须为 4 位数字");
            if(a.has("rateMode")&&!a.getString("rateMode").matches("auto|manual"))throw new Exception("汇率模式无效");
            if(a.has("rateAsOf"))date(a.getString("rateAsOf"));if(a.has("rateSource"))text(a,"rateSource",120,false);
        }
        Set<String> occurrences=new HashSet<>();BigInteger income=BigInteger.ZERO,expense=BigInteger.ZERO;
        for(int i=0;i<transactions.length();i++){JSONObject tx=transactions.getJSONObject(i);String type=tx.optString("type");if(!type.matches("income|expense|transfer"))throw new Exception("交易类型无效");integer(tx,"amount",1,MAX_MONEY);
            if(!accountIds.contains(tx.optString("accountId")))throw new Exception("交易账户不存在");String code=currency(find(accounts,tx.getString("accountId")));if(!code.equals(currency(tx)))throw new Exception("交易币种与账户不一致");long cny=transactionCnyAmount(tx);
            if(schema>=2&&!type.equals("transfer")){if(type.equals("income"))income=income.add(BigInteger.valueOf(cny));else expense=expense.add(BigInteger.valueOf(cny));if(income.compareTo(LIMIT)>0||expense.compareTo(LIMIT)>0)throw new Exception("累计人民币收支超过支持范围");}
            if(type.equals("transfer")){String target=tx.optString("toAccountId");if(!accountIds.contains(target)||target.equals(tx.getString("accountId")))throw new Exception("转入账户无效或与转出相同");String to=currency(find(accounts,target)),recorded=tx.has("toCurrency")?tx.getString("toCurrency"):"CNY";decimals(recorded);if(!to.equals(recorded))throw new Exception("转入币种不一致");if(!code.equals(to)&&!tx.has("toAmount"))throw new Exception("跨币种转账必须填写实际到账金额");if(tx.has("toAmount")){long amount=integer(tx,"toAmount",1,MAX_MONEY);if(code.equals(to)&&amount!=tx.getLong("amount"))throw new Exception("同币种转出和到账金额必须相同");}}
            else if(tx.has("toAmount")||tx.has("toCurrency")||!tx.optString("toAccountId","").isEmpty())throw new Exception("非转账不应包含转入账户或金额");
            text(tx,"category",50,false);text(tx,"title",120,false);date(tx.getString("date"));text(tx,"note",2000,true);
            if(tx.has("subscriptionId")&&(!subIds.contains(tx.optString("subscriptionId"))||!type.equals("expense")))throw new Exception("订阅交易关联无效");
            if(tx.has("occurrenceKey")){String key=text(tx,"occurrenceKey",100,false);if(!tx.has("subscriptionId")||!key.equals(tx.getString("subscriptionId")+":"+tx.getString("date").substring(0,7))||!occurrences.add(key))throw new Exception("订阅账期无效或重复");}
        }
        BigInteger recurringTotal=BigInteger.ZERO;
        for(int i=0;i<subs.length();i++){JSONObject sub=subs.getJSONObject(i);text(sub,"name",80,false);if(sub.has("serviceId"))id(sub,"serviceId",80);if(sub.has("tier"))text(sub,"tier",80,true);integer(sub,"amount",1,MAX_MONEY);JSONObject account=find(accounts,sub.optString("accountId"));if(account==null||!currency(account).equals(currency(sub)))throw new Exception("订阅账户或币种无效");long cny=toCnyCents(sub.getLong("amount"),currency(sub),currencyRate(account));
            if(!"会员订阅".equals(sub.optString("category")))throw new Exception("订阅分类必须为会员订阅");date(sub.getString("startDate"));integer(sub,"billingDay",1,31);bool(sub,"active");bool(sub,"recurring");color(sub);text(sub,"icon",80,false);
            for(String field:new String[]{"startHour","billingHour"})if(sub.has(field))integer(sub,field,0,23);
            if(schema<3&&(sub.has("startHour")||sub.has("billingHour")))throw new Exception("按小时扣账需要 schemaVersion 3，请升级电脑和手机应用");
            if(sub.has("intervalMonths")){requireSchema4(schema);intervalMonths(sub);if(!sub.getBoolean("recurring"))throw new Exception("单次订阅不能设置扣账周期");}
            SubscriptionDetails.validateSubscription(sub);
            if(sub.getBoolean("active")&&sub.getBoolean("recurring")){recurringTotal=recurringTotal.add(BigInteger.valueOf(cny).multiply(BigInteger.valueOf(12/intervalMonths(sub))));if(recurringTotal.compareTo(LIMIT)>0)throw new Exception("订阅年度折算超过支持范围");}
            JSONArray processed=array(sub,"processedOccurrences",3600);Set<String> unique=new HashSet<>();String prefix=sub.getString("id")+":";for(int j=0;j<processed.length();j++){String key=processed.getString(j);if(!key.startsWith(prefix)||!isValidDate(key.substring(prefix.length())+"-01")||!unique.add(key))throw new Exception("已处理订阅账期无效或重复");}
        }
        for(int i=0;i<goals.length();i++){JSONObject goal=goals.getJSONObject(i);text(goal,"name",80,false);integer(goal,"target",1,MAX_MONEY);integer(goal,"saved",0,MAX_MONEY);color(goal);if(goal.has("cover")){String cover=text(goal,"cover",250,true);if(!cover.isEmpty()&&(!cover.matches("/?assets/[A-Za-z0-9_./-]+")||cover.contains("..")))throw new Exception("目标封面须为本地 assets 资源");}}
        for(int i=0;i<goals.length();i++){JSONObject goal=goals.getJSONObject(i);if(goal.has("deadline")){requireSchema4(schema);date(text(goal,"deadline",10,false));}}
        balances(state,null);
    }
    private static void requireSchema4(long schema)throws Exception {if(schema<4)throw new Exception("订阅周期、分类预算、自定义分类和心愿目标日期需要 schemaVersion 4，请升级电脑和手机应用");}
    public static int intervalMonths(JSONObject sub)throws Exception {int interval=sub.has("intervalMonths")?(int)integer(sub,"intervalMonths",1,12):1;if(interval!=1&&interval!=3&&interval!=6&&interval!=12)throw new Exception("扣账周期只能为1、3、6或12个月");return interval;}
    public static String periodLabel(JSONObject sub){switch(sub.optInt("intervalMonths",1)){case 3:return "每季度";case 6:return "每半年";case 12:return "每年";default:return "每月";}}
    public static String periodUnit(JSONObject sub){switch(sub.optInt("intervalMonths",1)){case 3:return "季";case 6:return "半年";case 12:return "年";default:return "月";}}
    /** Convert each occurrence to CNY cents before half-up monthly division; annual fees never reuse that rounded mean. */
    public static long recurringTotal(JSONObject state,boolean annual)throws Exception {BigInteger total=BigInteger.ZERO;JSONArray subs=state.getJSONArray("subscriptions");for(int i=0;i<subs.length();i++){JSONObject sub=subs.getJSONObject(i);if(!sub.getBoolean("active")||!sub.getBoolean("recurring"))continue;JSONObject account=find(state.getJSONArray("accounts"),sub.getString("accountId"));long cny=toCnyCents(sub.getLong("amount"),currency(sub),currencyRate(account));int interval=intervalMonths(sub);total=total.add(annual?BigInteger.valueOf(cny).multiply(BigInteger.valueOf(12/interval)):BigInteger.valueOf(cny+interval/2).divide(BigInteger.valueOf(interval)));}return bounded(total,"订阅汇总");}
    public static String[] categories(JSONObject settings,String kind)throws Exception {java.util.List<String> values=new java.util.ArrayList<>();java.util.Collections.addAll(values,kind.equals("income")?LedgerCategories.INCOME:LedgerCategories.EXPENSE);JSONObject custom=settings.optJSONObject("customCategories");JSONArray extra=custom==null?null:custom.optJSONArray(kind);if(extra!=null)for(int i=0;i<extra.length();i++)values.add(extra.getString(i));return values.toArray(new String[0]);}
    public static JSONObject goalDeadline(JSONObject goal,String today)throws Exception {date(today);JSONObject result=new JSONObject();if(!goal.has("deadline"))return result;String deadline=goal.getString("deadline");date(deadline);LocalDate start=LocalDate.parse(today),end=LocalDate.parse(deadline);long days=end.toEpochDay()-start.toEpochDay(),remaining=Math.max(0,goal.getLong("target")-goal.getLong("saved"));result.put("date",deadline).put("days",days).put("overdue",days<0&&remaining>0);if(days>0&&remaining>0){long months=java.time.temporal.ChronoUnit.MONTHS.between(start,end);if(start.plusMonths(months).isBefore(end))months++;months=Math.max(1,months);result.put("monthlySaving",(remaining+months-1)/months);}return result;}
    public static JSONObject balances(JSONObject state,String asOf) throws Exception {
        if(asOf!=null)date(asOf);Map<String,BigInteger> exact=new LinkedHashMap<>();JSONArray accounts=state.getJSONArray("accounts"),txs=state.getJSONArray("transactions");
        for(int i=0;i<accounts.length();i++){JSONObject a=accounts.getJSONObject(i);exact.put(a.getString("id"),BigInteger.valueOf(a.getLong("openingBalance")));}
        for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);if(asOf!=null&&tx.getString("date").compareTo(asOf)>0)continue;String id=tx.getString("accountId");if(!exact.containsKey(id))throw new Exception("交易账户不存在");BigInteger delta=BigInteger.valueOf(tx.getLong("amount"));exact.put(id,exact.get(id).add(tx.getString("type").equals("income")?delta:delta.negate()));if(tx.getString("type").equals("transfer")){String target=tx.getString("toAccountId");if(!exact.containsKey(target))throw new Exception("转入账户不存在");exact.put(target,exact.get(target).add(BigInteger.valueOf(tx.has("toAmount")?tx.getLong("toAmount"):tx.getLong("amount"))));}}
        JSONObject result=new JSONObject();BigInteger total=BigInteger.ZERO;for(int i=0;i<accounts.length();i++){JSONObject a=accounts.getJSONObject(i);long value=bounded(exact.get(a.getString("id")),"账户余额");result.put(a.getString("id"),value);total=total.add(BigInteger.valueOf(toCnyCents(value,currency(a),currencyRate(a))));}bounded(total,"折算总资产");return result;
    }
    public static long netWorth(JSONObject state,String asOf) throws Exception { JSONObject values=balances(state,asOf);BigInteger total=BigInteger.ZERO;JSONArray accounts=state.getJSONArray("accounts");for(int i=0;i<accounts.length();i++){JSONObject a=accounts.getJSONObject(i);total=total.add(BigInteger.valueOf(toCnyCents(values.getLong(a.getString("id")),currency(a),currencyRate(a))));}return bounded(total,"折算总资产"); }
    private static JSONObject summary(JSONObject state,String prefix,String today) throws Exception {date(today);BigInteger income=BigInteger.ZERO,expense=BigInteger.ZERO;JSONArray txs=state.getJSONArray("transactions");for(int i=0;i<txs.length();i++){JSONObject tx=txs.getJSONObject(i);String when=tx.getString("date"),type=tx.getString("type");if(!when.startsWith(prefix)||when.compareTo(today)>0||type.equals("transfer"))continue;long amount=transactionCnyAmount(tx);if(type.equals("income"))income=income.add(BigInteger.valueOf(amount));else expense=expense.add(BigInteger.valueOf(amount));}return new JSONObject().put("income",bounded(income,"收入")).put("expense",bounded(expense,"支出")).put("balance",bounded(income.subtract(expense),"结余"));}
    public static JSONObject dailySummary(JSONObject state,String today) throws Exception {return summary(state,today,today);}
    public static JSONObject monthlySummary(JSONObject state,String month,String today) throws Exception {if(!isValidDate(month+"-01"))throw new Exception("统计月份无效");JSONObject result=summary(state,month+"-",today);long budget=state.getJSONObject("settings").getLong("monthlyBudget");return result.put("budget",budget).put("remaining",budget-result.getLong("expense"));}
    public static String addMonthsDue(String start,int index,int billingDay) throws Exception {date(start);if(index<0||index>3599||billingDay<1||billingDay>31)throw new Exception("订阅扣款月份无效");if(index==0)return start;YearMonth month=YearMonth.from(LocalDate.parse(start)).plusMonths(index);if(month.getYear()>2199)throw new Exception("订阅日期超过支持范围");return month.atDay(Math.min(billingDay,month.lengthOfMonth())).toString();}
    private static JSONArray dueDates(JSONObject sub,String today) throws Exception {date(today);JSONArray dates=new JSONArray();String start=sub.getString("startDate");if(start.compareTo(today)>0)return dates;if(!sub.getBoolean("recurring"))return dates.put(start);YearMonth first=YearMonth.from(LocalDate.parse(start)),last=YearMonth.from(LocalDate.parse(today));int count=(last.getYear()-first.getYear())*12+last.getMonthValue()-first.getMonthValue();for(int i=0;i<=count;i+=intervalMonths(sub)){String due=addMonthsDue(start,i,sub.getInt("billingDay"));if(due.compareTo(today)<=0)dates.put(due);}return dates;}
    private static Set<String> strings(JSONArray values) throws Exception {Set<String> result=new java.util.TreeSet<>();for(int i=0;i<values.length();i++)result.add(values.getString(i));return result;}
    public static int subscriptionDueHour(JSONObject sub,String due) throws Exception {
        String field=due.substring(0,7).equals(sub.getString("startDate").substring(0,7))?"startHour":"billingHour";
        return sub.has(field)?(int)integer(sub,field,0,23):0;
    }
    public static JSONObject setSubscriptionActive(JSONObject sub,boolean active,String today) throws Exception { return setSubscriptionActive(sub,active,today,0); }
    public static JSONObject setSubscriptionActive(JSONObject sub,boolean active,String today,int currentHour) throws Exception {
        if(currentHour<0||currentHour>23)throw new Exception("当前小时必须为 0 至 23");
        JSONObject result=copy(sub);
        if(active&&!sub.getBoolean("active")){
            Set<String> processed=strings(sub.getJSONArray("processedOccurrences"));
            JSONArray dates=dueDates(sub,today);
            for(int i=0;i<dates.length();i++){
                String due=dates.getString(i);
                if(due.compareTo(today)<0||due.equals(today)&&subscriptionDueHour(sub,due)<currentHour)
                    processed.add(sub.getString("id")+":"+due.substring(0,7));
            }
            result.put("processedOccurrences",new JSONArray(processed));
        }
        return result.put("active",active);
    }
    public static String nextSubscriptionDue(JSONObject sub,String today) throws Exception {
        date(today);
        if(!sub.getBoolean("active"))return null;
        Set<String> processed=strings(sub.getJSONArray("processedOccurrences"));
        String start=sub.getString("startDate"),id=sub.getString("id");
        if(!sub.getBoolean("recurring"))return processed.contains(id+":"+start.substring(0,7))?null:start;
        YearMonth first=YearMonth.from(LocalDate.parse(start));
        int last=(2199-first.getYear())*12+12-first.getMonthValue();
        for(int month=0;month<=last;month+=intervalMonths(sub)){
            String due=addMonthsDue(start,month,sub.getInt("billingDay"));
            if(!processed.contains(id+":"+due.substring(0,7)))return due;
        }
        return null;
    }

    /** Changing the grid never backfills dates before today; keep all pre-existing keys. */
    public static JSONObject changeSubscriptionInterval(JSONObject source,int interval,String today)throws Exception {
        date(today);JSONObject sub=copy(source);if(interval==1)sub.remove("intervalMonths");else sub.put("intervalMonths",interval);intervalMonths(sub);
        Set<String> processed=strings(sub.getJSONArray("processedOccurrences"));JSONArray dates=dueDates(sub,today);
        for(int i=0;i<dates.length();i++){String due=dates.getString(i);if(due.compareTo(today)<0)processed.add(sub.getString("id")+":"+due.substring(0,7));}
        return sub.put("processedOccurrences",new JSONArray(processed));
    }

    /** Manual changes establish a new expiry baseline without reusing already paid months. */
    public static JSONObject resetSubscriptionExpiry(JSONObject source,JSONArray transactions) throws Exception {
        JSONObject sub=copy(source),previous=sub.optJSONObject("expiryRenewal");
        if(!sub.optBoolean("recurring")||sub.optString("expiresOn").isEmpty()){
            sub.remove("expiryRenewal");return sub;
        }
        Set<String> baseline=new java.util.TreeSet<>();
        if(previous!=null){baseline.addAll(strings(previous.getJSONArray("baselineOccurrences")));baseline.addAll(strings(previous.getJSONArray("renewedOccurrences")));}
        for(int i=0;i<transactions.length();i++){
            JSONObject tx=transactions.getJSONObject(i);
            if("expense".equals(tx.optString("type"))&&sub.getString("id").equals(tx.optString("subscriptionId"))&&tx.has("occurrenceKey"))
                baseline.add(tx.getString("occurrenceKey"));
        }
        sub.put("expiryRenewal",new JSONObject().put("baseDate",sub.getString("expiresOn")).put("baselineOccurrences",new JSONArray(baseline)).put("renewedOccurrences",new JSONArray()));
        return sub;
    }
    /** Advance a membership once for each real automatic expense, retaining deleted paid history. */
    public static void reconcileSubscriptionExpiry(JSONObject state,String today,Set<String> newOccurrences) throws Exception {
        date(today);
        Map<String,Map<String,String>> billed=new LinkedHashMap<>();
        JSONArray transactions=state.getJSONArray("transactions");
        for(int i=0;i<transactions.length();i++){
            JSONObject tx=transactions.getJSONObject(i);
            if(!"expense".equals(tx.optString("type"))||!tx.has("subscriptionId")||!tx.has("occurrenceKey"))continue;
            String subscriptionId=tx.getString("subscriptionId");
            if(!billed.containsKey(subscriptionId))billed.put(subscriptionId,new LinkedHashMap<>());
            billed.get(subscriptionId).put(tx.getString("occurrenceKey"),tx.getString("date"));
        }
        JSONArray subscriptions=state.getJSONArray("subscriptions");
        for(int i=0;i<subscriptions.length();i++){
            JSONObject sub=subscriptions.getJSONObject(i);
            if(!sub.optBoolean("recurring")||sub.optString("expiresOn").isEmpty()){sub.remove("expiryRenewal");continue;}
            JSONObject previous=sub.optJSONObject("expiryRenewal");
            String baseDate=previous==null?sub.getString("expiresOn"):previous.getString("baseDate");
            Set<String> baseline=previous==null?new java.util.TreeSet<>():strings(previous.getJSONArray("baselineOccurrences"));
            Set<String> renewed=previous==null?new java.util.TreeSet<>():strings(previous.getJSONArray("renewedOccurrences"));
            Map<String,String> charges=billed.get(sub.getString("id"));
            if(charges!=null)for(Map.Entry<String,String> charge:charges.entrySet()){
                String key=charge.getKey(),chargedOn=charge.getValue();
                if(baseline.contains(key)||renewed.contains(key))continue;
                if(!newOccurrences.contains(key)&&chargedOn.compareTo(today)>0)continue;
                if(newOccurrences.contains(key)||chargedOn.compareTo(today)<=0&&(previous!=null||chargedOn.compareTo(baseDate)>=0))renewed.add(key);
                else if(previous==null)baseline.add(key);
            }
            sub.put("expiryRenewal",new JSONObject().put("baseDate",baseDate).put("baselineOccurrences",new JSONArray(baseline)).put("renewedOccurrences",new JSONArray(renewed)));
            sub.put("expiresOn",addMonthsDue(baseDate,renewed.size()*intervalMonths(sub),LocalDate.parse(baseDate).getDayOfMonth()));
        }
    }
    /** Exactly once per subscription/month. This records expenses; it never makes a payment. */
    public static JSONObject applyRecurring(JSONObject state,String today) throws Exception { return applyRecurring(state,today,23); }
    public static JSONObject applyRecurring(JSONObject state,String today,int currentHour) throws Exception {
        validateState(state);
        date(today);
        if(currentHour<0||currentHour>23)throw new Exception("当前小时必须为 0 至 23");
        JSONObject next=copy(state),available=balances(next,today);
        JSONArray added=new JSONArray(),transactions=next.getJSONArray("transactions"),subscriptions=next.getJSONArray("subscriptions");
        Set<String> occurrences=new HashSet<>(),transactionIds=new HashSet<>();
        for(int i=0;i<transactions.length();i++){
            JSONObject tx=transactions.getJSONObject(i);
            transactionIds.add(tx.getString("id"));
            if(tx.has("occurrenceKey"))occurrences.add(tx.getString("occurrenceKey"));
        }
        for(int i=0;i<subscriptions.length();i++){
            JSONObject sub=subscriptions.getJSONObject(i);
            if(!sub.getBoolean("active"))continue;
            Set<String> processed=strings(sub.getJSONArray("processedOccurrences"));
            JSONArray dates=dueDates(sub,today);
            for(int j=0;j<dates.length();j++){
                String due=dates.getString(j),key=sub.getString("id")+":"+due.substring(0,7);
                if(due.equals(today)&&subscriptionDueHour(sub,due)>currentHour||processed.contains(key))continue;
                if(!occurrences.contains(key)){
                    String accountId=sub.getString("accountId");
                    long fee=sub.getLong("amount"),remaining=available.getLong(accountId);
                    // Unfunded periods remain pending so a later top-up can pay them once.
                    if(remaining<fee)continue;
                    String id="rec_"+sub.getString("id")+"_"+due.substring(0,7).replace("-","");
                    if(!transactionIds.add(id))throw new Exception("自动记账 ID 冲突");
                    String tier=sub.optString("tier"),title=sub.getString("name")+(tier.isEmpty()?"":" · "+tier);
                    JSONObject account=find(next.getJSONArray("accounts"),accountId);
                    JSONObject tx=new JSONObject().put("id",id).put("type","expense").put("amount",fee).put("accountId",accountId)
                        .put("category","会员订阅").put("title",title.substring(0,Math.min(120,title.length()))).put("date",due)
                        .put("note","订阅到期自动记账"+(tier.isEmpty()?"":" · 会员档位："+tier)).put("subscriptionId",sub.getString("id")).put("occurrenceKey",key);
                    if(!currency(account).equals("CNY"))tx.put("currency",currency(account)).put("cnyRate",currencyRate(account));
                    transactions.put(tx);added.put(copy(tx));occurrences.add(key);
                    available.put(accountId,remaining-fee);
                }
                processed.add(key);
            }
            sub.put("processedOccurrences",new JSONArray(processed));
        }
        Set<String> newOccurrences=new HashSet<>();
        for(int i=0;i<added.length();i++)newOccurrences.add(added.getJSONObject(i).getString("occurrenceKey"));
        reconcileSubscriptionExpiry(next,today,newOccurrences);
        validateState(next);
        return new JSONObject().put("state",next).put("added",added);
    }
}
