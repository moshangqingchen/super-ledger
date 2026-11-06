package com.moneylab.superledger.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Pure Java gate for synthetic structured payment-result pages, never general OCR or chat text. */
public final class PaymentPageParser {
    private PaymentPageParser() {}
    public static boolean allowedPackage(String pkg){return "com.tencent.mm".equals(pkg)||"com.eg.android.AlipayGphone".equals(pkg);}
    /** Deliberately excludes generic web containers; new result activities need verified templates. */
    public static boolean allowedWindow(String pkg,String className){
        if(!allowedPackage(pkg)||className==null)return false;
        String c=className.toLowerCase(java.util.Locale.ROOT);
        if(c.matches(".*(?:chat|conversation|contact|launcher|search|history|input|password|webview|nebula).*")||!c.endsWith("activity")&&!c.endsWith("ui"))return false;
        if(pkg.equals("com.tencent.mm"))return (c.startsWith("com.tencent.mm.plugin.wallet.")||c.startsWith("com.tencent.mm.plugin.wallet_core."))&&(c.endsWith("walletpayui")||c.endsWith("walletpayresultui")||c.endsWith("walletpaymentresultui"));
        return c.startsWith("com.alipay.")&&(c.endsWith("paymentresultactivity")||c.endsWith("payresultactivity")||c.equals("com.alipay.android.app.flybird.ui.window.flybirdwindowactivity"));
    }
    public static PaymentParser.Parsed parse(String pkg,String windowClass,List<String> visibleText,boolean hasInputOrChat){
        if(hasInputOrChat||!allowedWindow(pkg,windowClass)||visibleText==null||visibleText.size()>120)return null;
        List<String> lines=new ArrayList<>();int size=0;boolean success=false;
        for(String value:visibleText){String line=PaymentParser.normalize(value);if(line.isEmpty())continue;size+=line.length();if(size>6000||line.length()>240)return null;
            if(line.matches("支付成功|付款成功|交易成功|已付款"))success=true;
            if(line.matches(".*(?:聊天记录|聊天详情|发送消息|按住说话|输入消息|转账给朋友|验证码|请输入密码|支付密码|支付失败|待付款|待支付).*"))return null;
            lines.add(line);
        }
        if(!success)return null;
        // UI label/value nodes are adjacent; join only a short, explicitly recognized field.
        List<String> fields=new ArrayList<>();boolean actual=false,merchant=false,method=false,order=false,time=false;
        for(int i=0;i<lines.size();i++){
            String line=lines.get(i);
            if(line.matches("实付金额|实际支付|实际付款|实付|付款金额|支付金额|商户|商户名称|商家名称|收款方|付款方式|支付方式|交易单号|订单号|支付时间|付款时间")&&i+1<lines.size())line=line+":"+lines.get(++i);
            if(line.matches("(?:实付金额|实际支付|实际付款|实付|付款金额|支付金额)\\s*:.*"))actual=true;
            if(line.matches("(?:商户|商户名称|商家名称|收款方)\\s*:.+"))merchant=true;
            if(line.matches("(?:付款方式|支付方式)\\s*:.+"))method=true;
            if(line.matches("(?:交易单号|订单号)\\s*:[A-Za-z0-9_-]{6,80}"))order=true;
            if(line.matches("(?:支付时间|付款时间)\\s*:.*[0-9].*"))time=true;
            // Keep only result and financial fields; never persist the full page, promotions or navigation.
            if(line.matches("支付成功|付款成功|交易成功|已付款")||Pattern.compile("^(?:实付|实际支付|实际付款|付款金额|支付金额|商户|商家名称|收款方|付款方式|支付方式|交易单号|订单号|支付时间|付款时间|原价|订单金额|优惠|立减|手续费|服务费).*[:：].*").matcher(line).matches())fields.add(line);
        }
        if(!actual||!merchant||!(method||order||time))return null;
        PaymentParser.Parsed p=PaymentParser.parse(pkg,pkg.equals("com.tencent.mm")?"微信支付":"支付宝",String.join("\n",fields));
        if(p==null||!p.completed)return null;
        p.captureMethod="screen";p.confident=false;p.reason=p.reason.isEmpty()?"付款页辅助识别，请核对实付金额、商家和账户":p.reason+"；付款页辅助识别需确认";
        // Only structured transaction metadata is saved by Store; omit the raw page text entirely.
        p.snippet="付款页辅助识别";
        return p;
    }
}
