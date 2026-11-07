package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Optional membership details, with the same schema and calendar rules as engine.mjs. */
public final class SubscriptionDetails {
    private SubscriptionDetails() {}

    public static final String[][] TYPES = {
        {"email", "邮箱"}, {"apple", "Apple 账户"}, {"google", "Google 账户"},
        {"phone", "手机号"}, {"wechat", "微信"}, {"qq", "QQ"}, {"other", "其他"}
    };

    public static String typeLabel(String id) {
        for (String[] type : TYPES) if (type[0].equals(id)) return type[1];
        return "其他";
    }

    private static boolean knownType(String id) {
        for (String[] type : TYPES) if (type[0].equals(id)) return true;
        return false;
    }

    private static String text(Object raw, String label, int max, boolean allowEmpty) throws Exception {
        if (!(raw instanceof String)) throw new Exception(label + "格式不正确");
        String value = (String) raw;
        // Match JavaScript String.trim(), including NBSP and BOM, without changing stored text.
        boolean blank = value.matches("[\\x09-\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*");
        if (value.length() > max || !allowEmpty && blank || value.matches("(?s).*[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F].*"))
            throw new Exception(label + "格式不正确");
        return value;
    }

    private static void validateLinkedAccount(JSONObject linked) throws Exception {
        if (linked == null) throw new Exception("关联账号必须是对象");
        Object type = linked.opt("type");
        if (!(type instanceof String) || !knownType((String) type)) throw new Exception("关联账号类型不正确");
        text(linked.opt("value"), "关联账号内容", 160, false);
        if (linked.has("label")) text(linked.opt("label"), "关联账号标注", 40, true);
    }

    /** Core booking fields are validated by MobileLedger; these additions remain optional for old backups. */
    public static void validateSubscription(JSONObject sub) throws Exception {
        if (sub.has("linkedAccounts")) {
            JSONArray linked = sub.optJSONArray("linkedAccounts");
            if (linked == null || linked.length() > 10) throw new Exception("关联账号必须是数组且不能超过10项");
            for (int i = 0; i < linked.length(); i++) validateLinkedAccount(linked.optJSONObject(i));
        }
        if (sub.has("note")) text(sub.opt("note"), "订阅备注", 500, true);
        if (sub.has("expiresOn")) {
            String expiry = text(sub.opt("expiresOn"), "会员到期日期", 10, true);
            if (!expiry.isEmpty()) {
                if (!MobileLedger.isValidDate(expiry)) throw new Exception("会员到期日期必须为 1900 至 2199 年的有效 YYYY-MM-DD");
                if (expiry.compareTo(sub.getString("startDate")) < 0) throw new Exception("会员到期日期不能早于首次扣款日期");
            }
        }
        if (sub.has("expiryRenewal")) {
            JSONObject renewal = sub.optJSONObject("expiryRenewal");
            if (renewal == null || !sub.optBoolean("recurring") || sub.optString("expiresOn").isEmpty())
                throw new Exception("到期续期记录需要连续订阅和会员到期日期");
            String baseDate = text(renewal.opt("baseDate"), "续期基准日期", 10, false);
            if (!MobileLedger.isValidDate(baseDate)) throw new Exception("续期基准日期无效");
            Set<String> keys = new HashSet<>();
            for (String field : new String[]{"baselineOccurrences", "renewedOccurrences"}) {
                JSONArray occurrences = renewal.optJSONArray(field);
                if (occurrences == null || occurrences.length() > 3600) throw new Exception("到期续期账期列表无效");
                String prefix = sub.getString("id") + ":";
                for (int i = 0; i < occurrences.length(); i++) {
                    Object raw = occurrences.get(i);
                    if (!(raw instanceof String)) throw new Exception("到期续期账期格式无效");
                    String key = (String) raw;
                    if (!key.startsWith(prefix) || !MobileLedger.isValidDate(key.substring(prefix.length()) + "-01") || !keys.add(key))
                        throw new Exception("到期续期账期无效或重复");
                }
            }
            String expected = MobileLedger.addMonthsDue(baseDate, renewal.getJSONArray("renewedOccurrences").length(), LocalDate.parse(baseDate).getDayOfMonth());
            if (!expected.equals(sub.getString("expiresOn"))) throw new Exception("会员到期日期与续期记录不一致");
        }
    }

    public static final class Status {
        public final String tone, label, detail, date, source;
        public final Long days;

        private Status(String tone, String label, String detail, String date, Long days, String source) {
            this.tone = tone; this.label = label; this.detail = detail;
            this.date = date; this.days = days; this.source = source;
        }
    }

    /** A reminder only: expiry never stops, creates, or reschedules a booking. */
    public static Status expiryStatus(JSONObject sub, String today) throws Exception {
        if (!MobileLedger.isValidDate(today)) throw new Exception("当前日期格式不正确");
        String target = sub.optString("expiresOn", "");
        String source = target.isEmpty() ? "none" : "expiry";
        if (target.isEmpty() && sub.optBoolean("recurring") && sub.optBoolean("active")) {
            target = MobileLedger.nextSubscriptionDue(sub, today);
            if (target != null) source = "renewal";
        }
        if (target == null || target.isEmpty())
            return new Status("unset", "未设置到期日期", "可在编辑中填写会员到期日期", null, null, "none");
        if (!MobileLedger.isValidDate(target)) throw new Exception("会员到期日期格式不正确");
        // LocalDate epoch days are UTC date ordinals, independent of timezone and DST changes.
        long days = LocalDate.parse(target).toEpochDay() - LocalDate.parse(today).toEpochDay();
        String action = source.equals("expiry") ? "到期" : "续费";
        String tone = days < 0 ? "expired" : days <= 7 ? "urgent" : days <= 30 ? "soon" : "normal";
        String label = days < 0 ? "已" + action + " " + -days + " 天" : days == 0 ? "今天" + action : days + " 天后" + action;
        if (source.equals("renewal") && days < 0)
            return new Status(tone, "待扣账 · 已逾期 " + -days + " 天", target + " · 待扣账", target, days, source);
        return new Status(tone, label, target + " · " + (source.equals("expiry") ? "会员到期" : "下次续费"), target, days, source);
    }

    private static void addSaved(Map<String, JSONObject> saved, JSONObject linked) throws Exception {
        validateLinkedAccount(linked);
        String key = new JSONArray().put(linked.getString("type")).put(linked.getString("value")).put(linked.optString("label", "")).toString();
        if (!saved.containsKey(key)) saved.put(key, new JSONObject(linked.toString()));
    }

    /** Reusable choices from existing memberships and Apple assets; no record is changed. */
    public static JSONArray savedLinkedAccounts(JSONObject state) throws Exception {
        Map<String, JSONObject> saved = new LinkedHashMap<>();
        JSONArray subscriptions = state.optJSONArray("subscriptions");
        if (subscriptions != null) for (int i = 0; i < subscriptions.length(); i++) {
            JSONObject sub = subscriptions.optJSONObject(i);
            JSONArray linked = sub == null ? null : sub.optJSONArray("linkedAccounts");
            if (linked != null) for (int j = 0; j < linked.length(); j++) addSaved(saved, linked.optJSONObject(j));
        }
        JSONArray accounts = state.optJSONArray("accounts");
        if (accounts != null) for (int i = 0; i < accounts.length(); i++) {
            JSONObject account = accounts.optJSONObject(i);
            if (!AppleBalance.isAppleBalance(account)) continue;
            String identity = account.optString("appleAccount", "").trim();
            if (identity.isEmpty()) continue;
            String region = AppleBalance.regionLabel(account.optString("appleRegion"));
            // A region fits the shared 40-character label limit and distinguishes the same login in different stores.
            JSONObject linked = new JSONObject().put("type", "apple").put("value", identity).put("label", region);
            addSaved(saved, linked);
        }
        JSONArray choices = new JSONArray();
        for (JSONObject linked : saved.values()) choices.put(linked);
        return choices;
    }
}
