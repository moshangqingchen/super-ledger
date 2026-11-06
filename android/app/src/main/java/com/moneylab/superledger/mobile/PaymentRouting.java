package com.moneylab.superledger.mobile;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Explicit funding evidence overrides the user default. */
public final class PaymentRouting {
    private PaymentRouting() {}
    public static final class Result {
        public String accountId="",reason="",method="";
        public final List<String> candidates=new ArrayList<>();
        public boolean exact;
    }
    public static Result match(PaymentParser.Parsed p,JSONArray accounts,String preferredAccountId){
        Result r=new Result();if(p==null||accounts==null){r.reason="请先选择账户";return r;}
        if(!p.knownSource){r.reason="来源未经确认，请选择实际付款账户";return r;}
        if(p.ambiguousFunding){r.reason="付款来源相互冲突，请核对账户";return r;}
        if(p.fundingSource.equals("credit")){r.reason="信用付款需确认负债账户，避免重复统计还款";return r;}
        JSONObject preferred=null;
        for(int i=0;i<accounts.length();i++){
            JSONObject a=accounts.optJSONObject(i);if(a==null||!a.optString("currency","CNY").equals("CNY"))continue;
            if(a.optString("id").equals(preferredAccountId))preferred=a;
            boolean eligible=false;
            if(p.fundingSource.equals("bank"))eligible=isCard(a)&&(p.bankId.isEmpty()||p.bankId.equals(a.optString("bankId")))&&(p.lastFour.isEmpty()||p.lastFour.equals(a.optString("lastFour")));
            else if(p.fundingSource.equals("wallet"))eligible=(p.paymentChannel.equals("wechat")||p.paymentChannel.equals("alipay"))&&p.paymentChannel.equals(a.optString("providerId"));
            if(eligible)r.candidates.add(a.optString("id"));
        }
        if(p.fundingSource.equals("bank")){
            if(r.candidates.size()==1&&!p.lastFour.isEmpty()){r.accountId=r.candidates.get(0);r.exact=true;r.method="bank-tail";return r;}
            r.reason=r.candidates.size()>1?"多张银行卡符合通知信息，请核对银行和尾号":p.lastFour.isEmpty()?"通知未给出银行卡尾号，请确认实际扣款卡":"未找到对应银行卡，请补充账户或核对尾号";return r;
        }
        if(p.fundingSource.equals("wallet")){
            if(r.candidates.size()==1){r.accountId=r.candidates.get(0);r.exact=true;r.method="wallet";return r;}
            if(r.candidates.size()>1&&r.candidates.contains(preferredAccountId)){r.accountId=preferredAccountId;r.exact=true;r.method="wallet-default";return r;}
            r.reason=r.candidates.isEmpty()?"未找到对应余额钱包账户":"多个钱包账户符合，请确认账户";return r;
        }
        if(preferred!=null){r.accountId=preferred.optString("id");r.exact=true;r.method="user-default";return r;}
        r.reason="通知未说明付款方式，请选择实际扣款账户或设置默认账户";return r;
    }
    private static boolean isCard(JSONObject a){return a.has("bankId")||a.has("lastFour")||a.optString("providerId").equals("bank-card")||a.optString("providerId").equals("virtual-card")||a.optString("type").matches(".*(?:银行卡|储蓄卡|信用卡|虚拟卡).*");}
}
