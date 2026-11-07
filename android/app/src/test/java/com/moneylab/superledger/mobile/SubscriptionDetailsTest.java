package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Desktop-compatible metadata, reminder boundaries, and saved identity regression checks. */
public final class SubscriptionDetailsTest {
    private static int checks;
    private interface Work { void run() throws Exception; }
    private static void check(boolean value, String label) { checks++; if (!value) throw new AssertionError(label); }
    private static void rejects(Work work, String label) throws Exception {
        try { work.run(); throw new AssertionError(label); }
        catch (AssertionError error) { throw error; }
        catch (Exception expected) { checks++; }
    }
    private static JSONObject sub() throws Exception {
        return new JSONObject().put("id", "member").put("name", "会员").put("amount", 1900)
            .put("accountId", "cash").put("category", "会员订阅").put("startDate", "2024-01-01")
            .put("billingDay", 1).put("recurring", true).put("active", true).put("color", "#123456")
            .put("icon", "spark").put("processedOccurrences", new JSONArray());
    }
    private static JSONObject linked(String type, String value, String label) throws Exception {
        JSONObject result = new JSONObject().put("type", type).put("value", value);
        if (label != null) result.put("label", label);
        return result;
    }
    private static JSONObject state(JSONObject subscription) throws Exception {
        JSONObject state = MobileLedger.emptyState();
        state.getJSONArray("accounts").put(new JSONObject().put("id", "cash").put("name", "现金")
            .put("type", "现金").put("color", "#ffffff").put("openingBalance", 100000));
        state.getJSONArray("subscriptions").put(subscription);
        return state;
    }
    public static void main(String[] args) throws Exception {
        SubscriptionDetails.validateSubscription(sub());
        check(true, "legacy subscriptions need no new metadata");
        JSONArray all = new JSONArray();
        for (String[] type : SubscriptionDetails.TYPES) {
            all.put(linked(type[0], type[0] + "@example.test", "个人账号"));
            check(SubscriptionDetails.typeLabel(type[0]).equals(type[1]), "known type has a readable label");
        }
        check(all.length() == 7, "all desktop account types are offered");
        JSONObject detailed = sub().put("linkedAccounts", all).put("expiresOn", "2026-12-31").put("note", "家庭共享\n到期核对");
        String original = detailed.toString();
        SubscriptionDetails.validateSubscription(detailed);
        check(original.equals(detailed.toString()), "validation does not normalize or discard saved details");
        SubscriptionDetails.validateSubscription(sub().put("linkedAccounts", new JSONArray()).put("expiresOn", "").put("note", ""));
        check(true, "empty details explicitly clear optional metadata");

        JSONArray tooMany = new JSONArray();
        for (int i = 0; i < 11; i++) tooMany.put(linked("email", "same@example.test", null));
        Object[] invalidLinks = {JSONObject.NULL, new JSONObject(), tooMany,
            new JSONArray().put(JSONObject.NULL), new JSONArray().put(new JSONArray()),
            new JSONArray().put(linked("unknown", "account", null)),
            new JSONArray().put(linked("email", "", null)), new JSONArray().put(linked("email", "   ", null)),
            new JSONArray().put(linked("email", "\u00a0\ufeff", null)),
            new JSONArray().put(new JSONObject().put("type", "email").put("value", 123)),
            new JSONArray().put(linked("email", "x".repeat(161), null)),
            new JSONArray().put(linked("email", "a\u0000b", null)),
            new JSONArray().put(linked("other", "account", "x".repeat(41))),
            new JSONArray().put(linked("other", "account", null).put("label", JSONObject.NULL))};
        for (Object invalid : invalidLinks) rejects(() -> SubscriptionDetails.validateSubscription(sub().put("linkedAccounts", invalid)), "malformed linked account rejected");
        for (Object invalid : new Object[]{JSONObject.NULL, 123, "x".repeat(501), "a\u0000b"})
            rejects(() -> SubscriptionDetails.validateSubscription(sub().put("note", invalid)), "invalid subscription note rejected");
        SubscriptionDetails.validateSubscription(sub().put("linkedAccounts", new JSONArray().put(linked("other", "x".repeat(160), "x".repeat(40)))).put("note", "x".repeat(500)));
        check(true, "metadata maximum lengths accepted exactly");
        for (Object invalid : new Object[]{JSONObject.NULL, 123, "2024-02-30", "2023-02-29", "2024-2-29", "2200-01-01", "          ", "2023-12-31"})
            rejects(() -> SubscriptionDetails.validateSubscription(sub().put("expiresOn", invalid)), "invalid or pre-start expiry rejected");
        SubscriptionDetails.validateSubscription(sub().put("expiresOn", "2024-01-01"));
        SubscriptionDetails.validateSubscription(sub().put("expiresOn", "2024-02-29"));
        check(true, "start-day and leap-day expiry accepted");

        String[][] boundaries = {{"2023-12-31", "-1", "expired", "已到期 1 天"}, {"2024-01-01", "0", "urgent", "今天到期"},
            {"2024-01-08", "7", "urgent", "7 天后到期"}, {"2024-01-09", "8", "soon", "8 天后到期"},
            {"2024-01-31", "30", "soon", "30 天后到期"}, {"2024-02-01", "31", "normal", "31 天后到期"}};
        for (String[] boundary : boundaries) {
            SubscriptionDetails.Status status = SubscriptionDetails.expiryStatus(sub().put("expiresOn", boundary[0]), "2024-01-01");
            check(status.days == Long.parseLong(boundary[1]) && status.tone.equals(boundary[2]) && status.label.equals(boundary[3])
                && status.date.equals(boundary[0]) && status.source.equals("expiry") && status.detail.equals(boundary[0] + " · 会员到期"), "inclusive urgency boundary and accessible text");
        }
        String[][] calendarCases = {{"2024-02-28", "2024-03-01", "2"}, {"2025-02-28", "2025-03-01", "1"},
            {"2024-12-31", "2025-01-01", "1"}, {"2026-03-07", "2026-03-09", "2"}, {"2026-10-31", "2026-11-02", "2"}};
        for (String[] item : calendarCases)
            check(SubscriptionDetails.expiryStatus(sub().put("expiresOn", item[1]), item[0]).days == Long.parseLong(item[2]), "calendar days independent of DST, month, year");
        rejects(() -> SubscriptionDetails.expiryStatus(sub(), "2026-02-30"), "invalid reference date rejected");
        JSONObject monthEnd = sub().put("startDate", "2024-01-31").put("billingDay", 31).put("processedOccurrences", new JSONArray().put("member:2024-01"));
        SubscriptionDetails.Status renewal = SubscriptionDetails.expiryStatus(monthEnd, "2024-02-22");
        check(renewal.days == 7 && renewal.tone.equals("urgent") && renewal.source.equals("renewal") && renewal.date.equals("2024-02-29")
            && renewal.label.equals("7 天后续费") && renewal.detail.equals("2024-02-29 · 下次续费"), "recurring fallback uses actual leap-month renewal");
        check(SubscriptionDetails.expiryStatus(monthEnd, "2024-02-29").label.equals("今天续费"), "renewal today is explicit");
        check(SubscriptionDetails.expiryStatus(new JSONObject(monthEnd.toString()).put("expiresOn", "2024-12-31"), "2024-02-22").date.equals("2024-12-31"), "explicit expiry precedes recurrence");
        check(SubscriptionDetails.expiryStatus(sub().put("startDate", "2027-01-31"), "2026-12-31").days == 31, "future first booking fallback");
        SubscriptionDetails.Status pending = SubscriptionDetails.expiryStatus(sub(), "2024-01-03");
        check(pending.label.equals("待扣账 · 已逾期 2 天") && pending.detail.equals("2024-01-01 · 待扣账"), "an overdue unpaid renewal stays visible as pending billing");
        for (String flag : new String[]{"active", "recurring"}) {
            JSONObject inactive = sub().put(flag, false);
            SubscriptionDetails.Status unset = SubscriptionDetails.expiryStatus(inactive, "2024-01-01");
            check(unset.tone.equals("unset") && unset.source.equals("none") && unset.date == null && unset.days == null, "paused and single subscriptions without explicit expiry stay unset");
            check(SubscriptionDetails.expiryStatus(inactive.put("expiresOn", "2024-01-08"), "2024-01-01").source.equals("expiry"), "paused and single subscriptions retain explicit expiry");
        }
        check(SubscriptionDetails.expiryStatus(sub().put("startDate", "2199-12-01").put("processedOccurrences", new JSONArray().put("member:2199-12")), "2199-12-01").tone.equals("unset"), "exhausted schedule safely stays unset");

        JSONObject withDetails = state(sub().put("expiresOn", "2024-01-02").put("linkedAccounts", new JSONArray().put(linked("apple", "owner@example.test", "美国"))).put("note", "提醒不改变扣账"));
        JSONObject plainResult = MobileLedger.applyRecurring(state(sub()), "2024-03-01");
        JSONObject detailResult = MobileLedger.applyRecurring(withDetails, "2024-03-01");
        check(plainResult.getJSONArray("added").toString().equals(detailResult.getJSONArray("added").toString()), "reminders and identities do not change recurring transactions");
        check(MobileLedger.applyRecurring(detailResult.getJSONObject("state"), "2024-03-01").getJSONArray("added").length() == 0, "details preserve exactly-once billing");

        JSONObject choicesState = new JSONObject().put("subscriptions", new JSONArray()
            .put(sub().put("linkedAccounts", new JSONArray().put(linked("email", "owner@example.test", null)).put(linked("apple", "owner@example.test", "美国"))))
            .put(sub().put("linkedAccounts", new JSONArray().put(linked("email", "owner@example.test", "")))))
            .put("accounts", new JSONArray()
                .put(new JSONObject().put("providerId", "apple-balance").put("appleRegion", "US").put("appleAccount", "owner@example.test"))
                .put(new JSONObject().put("providerId", "apple-balance").put("appleRegion", "TR").put("appleAccount", "owner@example.test"))
                .put(new JSONObject().put("providerId", "apple-balance").put("appleRegion", "JP").put("appleAccount", ""))
                .put(new JSONObject().put("providerId", "cash").put("appleAccount", "ignored@example.test")));
        String choicesBefore = choicesState.toString();
        JSONArray choices = SubscriptionDetails.savedLinkedAccounts(choicesState);
        check(choices.length() == 3, "saved choices deduplicate type, identity and label while retaining region distinctions");
        check(choices.getJSONObject(0).getString("type").equals("email") && choices.getJSONObject(2).getString("label").equals("土耳其"), "existing choices retain order and assets supply readable regions");
        choices.getJSONObject(0).put("value", "edited@example.test");
        check(choicesBefore.equals(choicesState.toString()), "saved choices are copies and never mutate assets or subscriptions");
        check(SubscriptionDetails.savedLinkedAccounts(new JSONObject()).length() == 0, "empty state has no saved account choices");
        System.out.println("SubscriptionDetails: " + checks + " metadata and reminder checks passed");
    }
}
