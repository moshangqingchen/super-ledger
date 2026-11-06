package com.moneylab.superledger.mobile;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
/** Synthetic accessibility node text only; not a device or payment-app compatibility test. */
public final class PaymentPageParserTest {
    private static int cases;
    private static final String WX="com.tencent.mm",WINDOW="com.tencent.mm.plugin.wallet.pay.ui.WalletPayUI";
    private static void check(boolean ok,String name){cases++;if(!ok)throw new AssertionError(name);}
    private static PaymentParser.Parsed parse(String...text){return PaymentPageParser.parse(WX,WINDOW,Arrays.asList(text),false);}
    public static void main(String[] args){
        PaymentParser.Parsed p=parse("支付成功","实付金额","28.00","商户名称","青禾生鲜","付款方式","零钱");
        check(p!=null&&p.amount==2800&&p.merchant.equals("青禾生鲜"),"adjacent label value synthetic result");
        check(!p.confident&&p.captureMethod.equals("screen")&&p.snippet.equals("付款页辅助识别"),"all page results review without raw text");
        check(parse("支付成功28元") == null,"single success sentence insufficient");
        check(parse("支付成功","实付金额：28元","商户：青禾") == null,"additional evidence required");
        check(parse("付款成功","实付：28元","付款方式：零钱") == null,"merchant evidence required");
        check(parse("付款成功","商户：青禾","付款方式：零钱") == null,"explicit payment amount required");
        check(parse("待付款","实付：28元","商户：青禾","付款方式：零钱") == null,"unpaid page ignored");
        check(parse("支付成功后领券","实付：28元","商户：青禾","付款方式：零钱") == null,"marketing sentence not success heading");
        List<String> valid=Arrays.asList("支付成功","实付：28元","商户：青禾","付款方式：零钱");
        check(PaymentPageParser.parse(WX,WINDOW,valid,true)==null,"input metadata rejects page before text capture");
        check(PaymentPageParser.parse(WX,"com.tencent.mm.ui.chatting.ChattingUI",valid,false)==null,"chat activity excluded");
        check(PaymentPageParser.parse(WX,"com.tencent.mm.ui.LauncherUI",valid,false)==null,"generic launcher excluded");
        check(PaymentPageParser.parse("example.app",WINDOW,valid,false)==null,"other app excluded");
        check(parse("聊天记录","支付成功","实付：28元","商户：青禾","付款方式：零钱")==null,"chat history marker excludes page");
        check(parse("输入消息","支付成功","实付：28元","商户：青禾","付款方式：零钱")==null,"chat input marker excluded");
        check(parse("支付密码","支付成功","实付：28元","商户：青禾","付款方式：零钱")==null,"password marker excluded");
        p=parse("支付成功","实付：28元","实付：30元","商户：青禾","付款方式：零钱");
        check(p!=null&&p.amount==0&&!p.confident,"ambiguous structured amount goes to review");
        p=parse("支付成功","原价：30元","优惠：2元","实付：28元","商户：青禾","付款方式：零钱","无关促销内容");
        check(p!=null&&p.amount==2800&&!p.snippet.contains("促销"),"discount and minimization");
        p=parse("付款成功","实付：28元","商户：青禾","订单号：SYNTHETIC001");
        check(p!=null&&p.reference.equals("SYNTHETIC001"),"order corroborates result");
        check(PaymentPageParser.parse("com.eg.android.AlipayGphone","com.alipay.mobile.nebulax.integration.mpaas.activity.NebulaActivity",valid,false)==null,"unverified generic web page excluded");
        p=PaymentPageParser.parse("com.eg.android.AlipayGphone","com.alipay.android.app.flybird.ui.window.FlyBirdWindowActivity",valid,false);
        check(p!=null&&p.paymentChannel.equals("alipay")&&!p.confident,"synthetic Alipay payment window");
        List<String> longPage=new ArrayList<>(valid);for(int i=0;i<121;i++)longPage.add("填充");
        check(PaymentPageParser.parse(WX,WINDOW,longPage,false)==null,"oversized page rejected");
        check(!PaymentPageParser.allowedWindow(WX,"com.tencent.mm.plugin.wallet.history.HistoryUI"),"history window excluded");
        check(!PaymentPageParser.allowedWindow(WX,"com.tencent.mm.plugin.wallet.bill.ui.BillUI"),"wallet bill listing excluded");
        check(!PaymentPageParser.allowedWindow(WX,"com.tencent.mm.plugin.wallet_core.ui.WalletOrderInfoNewUI"),"historical order detail excluded");
        System.out.println("PaymentPageParser: "+cases+" checks passed");
    }
}
