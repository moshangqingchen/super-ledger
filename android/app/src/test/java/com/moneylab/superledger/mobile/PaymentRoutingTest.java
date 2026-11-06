package com.moneylab.superledger.mobile;
import org.json.JSONArray;
import org.json.JSONObject;
/** Synthetic account routing cases, no personal accounts. */
public final class PaymentRoutingTest {
    private static int cases;
    private static void check(boolean ok,String name){cases++;if(!ok)throw new AssertionError(name);}
    private static JSONObject account(String id,String provider,String bank,String tail)throws Exception {JSONObject a=new JSONObject().put("id",id).put("providerId",provider).put("currency","CNY");if(!bank.isEmpty())a.put("bankId",bank);if(!tail.isEmpty())a.put("lastFour",tail);return a;}
    private static PaymentParser.Parsed parse(String method){return PaymentParser.parse("com.tencent.mm","微信支付","付款成功28元\n付款方式："+method);}
    public static void main(String[] args)throws Exception {
        JSONArray accounts=new JSONArray().put(account("wx","wechat","","")).put(account("ali","alipay","","")).put(account("cmb","bank-card","cmb","1234")).put(account("icbc","bank-card","icbc","1234"));
        PaymentRouting.Result r=PaymentRouting.match(parse("招商银行(1234)"),accounts,"wx");
        check(r.exact&&r.accountId.equals("cmb")&&r.method.equals("bank-tail"),"explicit bank overrides wallet default");
        r=PaymentRouting.match(parse("银行卡(1234)"),accounts,"wx");check(!r.exact&&r.accountId.isEmpty()&&r.candidates.size()==2,"same tail multiple banks reviewed");
        r=PaymentRouting.match(parse("零钱"),accounts,"cmb");check(r.exact&&r.accountId.equals("wx"),"explicit wallet overrides card default");
        r=PaymentRouting.match(parse("银行卡(9876)"),accounts,"wx");check(!r.exact&&r.accountId.isEmpty(),"missing card never wallet fallback");
        r=PaymentRouting.match(parse("招商银行"),accounts,"cmb");check(!r.exact,"bank without tail reviewed even with default");
        PaymentParser.Parsed unknownFunding=PaymentParser.parse("com.tencent.mm","微信支付","付款成功28元");
        check(!PaymentRouting.match(unknownFunding,accounts,"").exact,"source alone does not imply wallet");
        check(PaymentRouting.match(unknownFunding,accounts,"wx").method.equals("user-default"),"explicit user default usable without contrary evidence");
        check(!PaymentRouting.match(unknownFunding,accounts,"deleted").exact,"deleted default ignored");
        PaymentParser.Parsed unknownSource=PaymentParser.parse("unknown","通知","付款成功28元\n付款方式：零钱");
        check(!PaymentRouting.match(unknownSource,accounts,"wx").exact,"unknown source never exact");
        check(!PaymentRouting.match(parse("零钱和招商银行(1234)"),accounts,"wx").exact,"mixed funding never exact");
        PaymentParser.Parsed credit=PaymentParser.parse("com.eg.android.AlipayGphone","支付宝","付款成功28元\n付款方式：花呗");
        check(!PaymentRouting.match(credit,accounts,"ali").exact,"credit does not reduce balance wallet");
        JSONArray duplicate=new JSONArray(accounts.toString()).put(account("cmb2","bank-card","cmb","1234"));
        check(!PaymentRouting.match(parse("招商银行(1234)"),duplicate,"cmb").exact,"same bank same tail not disambiguated by default");
        JSONArray usd=new JSONArray().put(account("usd","bank-card","cmb","1234").put("currency","USD"));
        check(!PaymentRouting.match(parse("招商银行(1234)"),usd,"usd").exact,"foreign card not used for CNY receipt");
        JSONArray twoWallets=new JSONArray().put(account("wx1","wechat","","")).put(account("wx2","wechat","",""));
        check(!PaymentRouting.match(parse("零钱"),twoWallets,"").exact,"multiple wallets reviewed without preference");
        check(PaymentRouting.match(parse("零钱"),twoWallets,"wx2").accountId.equals("wx2"),"explicit matching wallet preference");
        check(!PaymentRouting.match(parse("零钱"),new JSONArray(),"wx").exact,"empty ledger reviewed");
        System.out.println("PaymentRouting: "+cases+" checks passed");
    }
}
