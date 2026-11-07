package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Expiry credits must match real monthly expenses and survive retries, edits and migration. */
public final class SubscriptionRenewalTest {
    private static int checks;
    private interface Work { void run() throws Exception; }
    private static void check(boolean condition,String message) { checks++;if(!condition)throw new AssertionError(message); }
    private static void rejects(Work work,String message)throws Exception {
        try{work.run();throw new AssertionError(message);}catch(AssertionError error){throw error;}catch(Exception expected){checks++;}
    }
    private static JSONObject state(String start,String expiry)throws Exception {
        JSONObject state=MobileLedger.emptyState();
        state.getJSONArray("accounts").put(MobileLedgerTest.account("bank","CNY",100000,null));
        JSONObject sub=MobileLedgerTest.subscription("member","bank",100,start,true).put("billingDay",31);
        if(expiry!=null)sub.put("expiresOn",expiry);
        state.getJSONArray("subscriptions").put(sub);return state;
    }
    private static JSONObject sub(JSONObject state)throws Exception { return state.getJSONArray("subscriptions").getJSONObject(0); }
    private static JSONObject applied(JSONObject state,String today)throws Exception { return MobileLedger.applyRecurring(state,today).getJSONObject("state"); }
    public static void main(String[] args)throws Exception {
        JSONObject initial=state("2024-01-31","2024-01-31");String original=initial.toString();
        JSONObject january=applied(initial,"2024-01-31");
        check(initial.toString().equals(original),"renewal never mutates its input ledger");
        check(sub(january).getString("expiresOn").equals("2024-02-29"),"January 31 renews to leap-day February");
        check(sub(january).getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").length()==1,"one paid occurrence earns one month");
        JSONObject february=applied(january,"2024-02-29");
        check(sub(february).getString("expiresOn").equals("2024-03-31"),"February clamping preserves the original 31st-day anchor");
        check(sub(applied(february,"2024-03-31")).getString("expiresOn").equals("2024-04-30"),"subsequent short months clamp independently");
        JSONObject ordinary=applied(state("2025-01-31","2025-01-31"),"2025-02-28");
        check(sub(ordinary).getString("expiresOn").equals("2025-03-31"),"non-leap February returns to March 31");
        JSONObject repeated=MobileLedger.applyRecurring(january,"2024-01-31");
        check(repeated.getJSONArray("added").length()==0&&sub(repeated.getJSONObject("state")).getString("expiresOn").equals("2024-02-29"),"same-period retries do not extend expiry twice");
        JSONObject future=applied(state("2026-11-07","2026-12-31"),"2026-11-07");
        check(sub(future).getString("expiresOn").equals("2027-01-31"),"a new paid month extends an already future expiry");
        JSONObject catchup=MobileLedger.applyRecurring(initial,"2024-03-31");
        check(catchup.getJSONArray("added").length()==3&&sub(catchup.getJSONObject("state")).getString("expiresOn").equals("2024-04-30"),"three catch-up expenses earn exactly three months");

        JSONObject legacy=applied(state("2024-01-31",null),"2024-01-31");sub(legacy).put("expiresOn","2024-01-31");
        JSONObject repaired=MobileLedger.applyRecurring(legacy,"2024-01-31");
        check(repaired.getJSONArray("added").length()==0&&sub(repaired.getJSONObject("state")).getString("expiresOn").equals("2024-02-29"),"already-booked legacy current periods repair expiry without another expense");
        check(sub(applied(repaired.getJSONObject("state"),"2024-01-31")).getString("expiresOn").equals("2024-02-29"),"legacy repair is idempotent");
        JSONObject alreadyRenewed=MobileLedger.copy(legacy);sub(alreadyRenewed).put("expiresOn","2024-02-29");
        JSONObject retained=applied(alreadyRenewed,"2024-01-31");
        check(sub(retained).getString("expiresOn").equals("2024-02-29")&&sub(retained).getJSONObject("expiryRenewal").getJSONArray("baselineOccurrences").length()==1,"existing future expiry treats older paid months as baseline");
        JSONObject importedFuture=state("2024-01-31","2024-03-31");sub(importedFuture).put("active",false);
        importedFuture.getJSONArray("transactions").put(MobileLedgerTest.tx("rec_member_202403","expense","bank",100,"2024-03-31").put("subscriptionId","member").put("occurrenceKey","member:2024-03"));
        JSONObject beforeFutureCharge=applied(importedFuture,"2024-02-01");
        JSONObject futureHistory=sub(beforeFutureCharge).getJSONObject("expiryRenewal");
        check(futureHistory.getJSONArray("baselineOccurrences").length()==0&&futureHistory.getJSONArray("renewedOccurrences").length()==0,"a future imported automatic expense waits without permanently consuming its renewal credit");
        JSONObject futureChargeDue=applied(beforeFutureCharge,"2024-03-31");
        check(sub(futureChargeDue).getString("expiresOn").equals("2024-04-30")&&sub(futureChargeDue).getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").length()==1,"an imported automatic expense earns its month when its Beijing date arrives");
        check(sub(applied(futureChargeDue,"2024-03-31")).getString("expiresOn").equals("2024-04-30"),"rechecking an imported paid period cannot extend it again");
        JSONObject skipped=state("2024-01-31","2024-01-31");sub(skipped).put("active",false).getJSONArray("processedOccurrences").put("member:2024-01");
        check(sub(applied(skipped,"2024-01-31")).getString("expiresOn").equals("2024-01-31"),"paused processed markers without an expense never renew membership");
        JSONObject once=state("2024-01-31","2024-01-31");sub(once).put("recurring",false);
        JSONObject single=applied(once,"2024-01-31");
        check(sub(single).getString("expiresOn").equals("2024-01-31")&&!sub(single).has("expiryRenewal"),"single subscriptions retain their explicit expiry");
        JSONObject unset=applied(state("2024-01-31",null),"2024-01-31");
        check(!sub(unset).has("expiresOn")&&!sub(unset).has("expiryRenewal"),"unset expiry continues to use schedule reminders");
        JSONObject deleted=MobileLedger.copy(january);deleted.getJSONArray("transactions").remove(0);
        check(sub(applied(deleted,"2024-01-31")).getString("expiresOn").equals("2024-02-29"),"deleting a paid transaction retains its renewal credit");

        JSONObject edited=MobileLedger.resetSubscriptionExpiry(MobileLedger.copy(sub(january)).put("expiresOn","2024-02-15"),january.getJSONArray("transactions"));
        check(edited.getJSONObject("expiryRenewal").getJSONArray("baselineOccurrences").length()==1&&edited.getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").length()==0,"manual expiry edits establish a new baseline");
        JSONObject editedState=MobileLedger.copy(january);editedState.getJSONArray("subscriptions").put(0,edited);
        check(sub(applied(editedState,"2024-01-31")).getString("expiresOn").equals("2024-02-15"),"an existing charge cannot undo a manual date edit");
        check(sub(applied(editedState,"2024-02-29")).getString("expiresOn").equals("2024-03-15"),"later renewal uses the manually selected day");
        JSONObject cleared=MobileLedger.resetSubscriptionExpiry(MobileLedger.copy(sub(january)).put("expiresOn",""),january.getJSONArray("transactions"));
        check(!cleared.has("expiryRenewal"),"clearing expiry removes its renewal metadata");
        JSONObject switched=MobileLedger.resetSubscriptionExpiry(MobileLedger.copy(sub(january)).put("recurring",false),january.getJSONArray("transactions"));
        check(!switched.has("expiryRenewal"),"switching to single removes renewal metadata");

        JSONObject invalid=MobileLedger.copy(january);sub(invalid).put("expiresOn","2024-03-31");
        rejects(()->MobileLedger.validateState(invalid),"expiry must equal the renewal baseline plus paid credits");
        JSONObject overlap=MobileLedger.copy(january);sub(overlap).getJSONObject("expiryRenewal").getJSONArray("baselineOccurrences").put("member:2024-01");
        rejects(()->MobileLedger.validateState(overlap),"baseline and renewed occurrence sets must be disjoint");
        JSONObject duplicate=MobileLedger.copy(january);sub(duplicate).getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").put("member:2024-01");
        rejects(()->MobileLedger.validateState(duplicate),"renewed occurrence keys cannot repeat");
        JSONObject otherSubscription=MobileLedger.copy(january);sub(otherSubscription).getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").put(0,"other:2024-01");
        rejects(()->MobileLedger.validateState(otherSubscription),"renewal occurrence keys must belong to this subscription");
        JSONObject badDate=MobileLedger.copy(january);sub(badDate).getJSONObject("expiryRenewal").put("baseDate","2024-02-30");
        rejects(()->MobileLedger.validateState(badDate),"renewal baseline must be a real date");
        JSONObject beyond=state("2199-12-01","2199-12-31");String before=beyond.toString();
        rejects(()->MobileLedger.applyRecurring(beyond,"2199-12-01"),"renewal beyond supported dates fails atomically");
        check(beyond.toString().equals(before),"a failed expiry extension preserves the input ledger and its transactions");
        JSONObject unfunded=state("2024-01-31","2024-01-31");unfunded.getJSONArray("accounts").getJSONObject(0).put("openingBalance",0);
        JSONObject waiting=MobileLedger.applyRecurring(unfunded,"2024-01-31");
        JSONObject waitingState=waiting.getJSONObject("state");
        check(waiting.getJSONArray("added").length()==0&&sub(waitingState).getJSONArray("processedOccurrences").length()==0,"insufficient balance leaves the period pending without an expense");
        check(sub(waitingState).getString("expiresOn").equals("2024-01-31")&&sub(waitingState).getJSONObject("expiryRenewal").getJSONArray("renewedOccurrences").length()==0,"insufficient balance earns no expiry extension");
        check(MobileLedger.nextSubscriptionDue(sub(waitingState),"2024-02-01").equals("2024-01-31"),"the earliest unpaid period remains visible after its due date");
        waitingState.getJSONArray("transactions").put(MobileLedgerTest.tx("topup99","income","bank",99,"2024-02-01"));
        JSONObject shortByOne=MobileLedger.applyRecurring(waitingState,"2024-02-01");
        check(shortByOne.getJSONArray("added").length()==0,"one minor unit short does not allow an automatic charge");
        waitingState=shortByOne.getJSONObject("state");waitingState.getJSONArray("transactions").put(MobileLedgerTest.tx("topup1","income","bank",1,"2024-02-01"));
        JSONObject paidAfterTopup=MobileLedger.applyRecurring(waitingState,"2024-02-01");
        check(paidAfterTopup.getJSONArray("added").length()==1&&paidAfterTopup.getJSONArray("added").getJSONObject(0).getString("date").equals("2024-01-31"),"today's top-up funds the previously unpaid period using its original booking date");
        JSONObject fundedState=paidAfterTopup.getJSONObject("state");
        check(MobileLedger.balances(fundedState,"2024-02-01").getLong("bank")==0&&sub(fundedState).getString("expiresOn").equals("2024-02-29"),"an exact-balance payment consumes the funds and extends membership once");
        check(MobileLedger.applyRecurring(fundedState,"2024-02-01").getJSONArray("added").length()==0,"rechecking after a top-up cannot pay the same period twice");
        fundedState.getJSONArray("transactions").put(MobileLedgerTest.tx("futuretopup","income","bank",100,"2024-03-01"));
        check(MobileLedger.applyRecurring(fundedState,"2024-02-29").getJSONArray("added").length()==0,"future income cannot fund today's automatic charge");
        check(MobileLedger.applyRecurring(fundedState,"2024-03-01").getJSONArray("added").length()==1,"a pending charge resumes when a dated top-up becomes available");
        JSONObject partial=state("2024-01-31","2024-01-31");partial.getJSONArray("accounts").getJSONObject(0).put("openingBalance",250);
        JSONObject partialResult=MobileLedger.applyRecurring(partial,"2024-03-31");JSONObject partialState=partialResult.getJSONObject("state");
        check(partialResult.getJSONArray("added").length()==2&&MobileLedger.balances(partialState,"2024-03-31").getLong("bank")==50,"historical catch-up spends only the funds available for each successive period");
        check(sub(partialState).getJSONArray("processedOccurrences").length()==2&&sub(partialState).getString("expiresOn").equals("2024-03-31"),"only paid catch-up periods are processed and extend expiry");
        partialState.getJSONArray("transactions").put(MobileLedgerTest.tx("catchup_topup","income","bank",50,"2024-03-31"));
        JSONObject completed=MobileLedger.applyRecurring(partialState,"2024-03-31");
        check(completed.getJSONArray("added").length()==1&&sub(completed.getJSONObject("state")).getString("expiresOn").equals("2024-04-30"),"a later top-up completes only the still-pending catch-up period");
        JSONObject shared=state("2024-01-31","2024-01-31");shared.getJSONArray("accounts").getJSONObject(0).put("openingBalance",150);
        shared.getJSONArray("subscriptions").put(MobileLedgerTest.subscription("second","bank",60,"2024-01-31",true).put("expiresOn","2024-01-31"));
        JSONObject sharedResult=MobileLedger.applyRecurring(shared,"2024-01-31");JSONObject sharedState=sharedResult.getJSONObject("state");
        check(sharedResult.getJSONArray("added").length()==1&&sharedState.getJSONArray("subscriptions").getJSONObject(1).getJSONArray("processedOccurrences").length()==0,"subscriptions sharing an account cannot each spend the same available balance");
        sharedState.getJSONArray("transactions").put(MobileLedgerTest.tx("second_topup","income","bank",10,"2024-02-01"));
        check(MobileLedger.applyRecurring(sharedState,"2024-02-01").getJSONArray("added").length()==1,"a later top-up funds the other subscription without replaying the first");
        JSONObject micro=state("2024-01-31","2024-01-31").put("schemaVersion",2);
        micro.getJSONArray("accounts").getJSONObject(0).put("currency","USDT").put("cnyRate","7.2").put("openingBalance",1000000);
        sub(micro).put("currency","USDT").put("amount",1000001);
        check(MobileLedger.applyRecurring(micro,"2024-01-31").getJSONArray("added").length()==0,"USDT funding respects every micro-unit without CNY conversion or rounding");
        micro.getJSONArray("accounts").getJSONObject(0).put("openingBalance",1000001);
        check(MobileLedger.applyRecurring(micro,"2024-01-31").getJSONArray("added").length()==1,"an exact USDT micro-unit balance funds one charge");
        JSONObject recorded=state("2024-01-31","2024-01-31");recorded.getJSONArray("accounts").getJSONObject(0).put("openingBalance",100);
        recorded.getJSONArray("transactions").put(MobileLedgerTest.tx("rec_member_202401","expense","bank",100,"2024-01-31").put("subscriptionId","member").put("occurrenceKey","member:2024-01"));
        JSONObject recognized=MobileLedger.applyRecurring(recorded,"2024-01-31");
        check(recognized.getJSONArray("added").length()==0&&sub(recognized.getJSONObject("state")).getJSONArray("processedOccurrences").length()==1&&MobileLedger.balances(recognized.getJSONObject("state"),"2024-01-31").getLong("bank")==0,"an existing real charge is recognized without checking or deducting its already-spent funds again");
        JSONObject expensiveFirst=state("2024-01-31","2024-01-31");expensiveFirst.getJSONArray("accounts").getJSONObject(0).put("openingBalance",150);sub(expensiveFirst).put("amount",200);
        expensiveFirst.getJSONArray("subscriptions").put(MobileLedgerTest.subscription("affordable","bank",60,"2024-01-31",true));
        JSONObject affordableResult=MobileLedger.applyRecurring(expensiveFirst,"2024-01-31");
        check(affordableResult.getJSONArray("added").length()==1&&affordableResult.getJSONArray("added").getJSONObject(0).getString("subscriptionId").equals("affordable")&&sub(affordableResult.getJSONObject("state")).getJSONArray("processedOccurrences").length()==0,"an unfunded expensive plan does not prevent another affordable subscription from being processed");
        System.out.println("SubscriptionRenewal: "+checks+" renewal checks passed");
    }
}
