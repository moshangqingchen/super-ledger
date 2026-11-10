package com.moneylab.superledger.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Budget choices include old free-text expenses without changing stored category data. */
public final class BudgetCategoriesTest {
    private static int checks;
    private static void check(boolean condition,String label){checks++;if(!condition)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        JSONObject state=MobileLedger.emptyState().put("schemaVersion",4);
        check(Arrays.equals(MobileLedger.budgetCategories(state),LedgerCategories.EXPENSE),"an empty ledger retains the canonical expense choices and order");
        state.getJSONArray("accounts").put(MobileLedgerTest.account("wallet","CNY",100000,null));
        state.getJSONArray("transactions").put(MobileLedgerTest.tx("old","expense","wallet",100,"2026-01-01").put("category","宠物"));
        check(Arrays.asList(MobileLedger.budgetCategories(state)).contains("宠物"),"a historical expense is budgetable before any custom category or category budget exists");
        state.getJSONObject("settings").put("customCategories",new JSONObject().put("expense",new JSONArray().put("园艺").put("宠物")).put("income",new JSONArray().put("稿费")))
            .put("categoryBudgets",new JSONObject().put("已归档支出",500).put("宠物",1000));
        state.getJSONArray("transactions").put(MobileLedgerTest.tx("old2","expense","wallet",100,"2026-02-01").put("category","露营"))
            .put(MobileLedgerTest.tx("repeat","expense","wallet",100,"2026-02-02").put("category","宠物"))
            .put(MobileLedgerTest.tx("income","income","wallet",100,"2026-02-03").put("category","仅收入"));
        state.getJSONArray("accounts").put(MobileLedgerTest.account("target","CNY",0,null));
        state.getJSONArray("transactions").put(MobileLedgerTest.tx("transfer","transfer","wallet",100,"2026-02-04").put("toAccountId","target").put("category","仅转账"));
        MobileLedger.validateState(state);String before=state.toString();List<String> choices=Arrays.asList(MobileLedger.budgetCategories(state));
        check(choices.contains("园艺")&&choices.contains("露营")&&choices.contains("已归档支出"),"custom expense, historical expense and budget-only categories all remain available");
        check(!choices.contains("稿费")&&!choices.contains("仅收入")&&!choices.contains("仅转账"),"income preferences and income/transfer history do not create expense budget fields");
        check(Collections.frequency(choices,"宠物")==1,"categories shared by custom choices, repeated history and budgets appear once");
        check(choices.indexOf("园艺")==LedgerCategories.EXPENSE.length&&choices.indexOf("露营")>choices.indexOf("宠物")&&choices.indexOf("已归档支出")>choices.indexOf("露营"),"choice precedence matches desktop: built-ins, custom expenses, historical expenses, then budget-only keys");
        check(state.toString().equals(before),"building the budget form choices leaves the ledger and settings unchanged");
        state.getJSONObject("settings").remove("customCategories");
        check(Arrays.asList(MobileLedger.budgetCategories(state)).contains("宠物"),"removing the preference does not hide a still-budgeted or historical expense category");
        System.out.println("BudgetCategories: "+checks+" legacy expense, deduplication and read-only planning checks passed");
    }
}
