package com.moneylab.superledger.mobile;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Conservative financial-notification parser. No notification text leaves the device. */
public final class PaymentParser {
    private PaymentParser() {}
    public static final class Parsed {
        public long amount;
        public String type = "expense", title = "", category = "其他支出", lastFour = "", reference = "", merchant = "", reason = "", snippet = "";
        public boolean confident;
    }
    private static final String NUMBER = "(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?";
    private static final Pattern MONEY = Pattern.compile("(?:人民币|RMB|CNY|[¥￥])\\s*(" + NUMBER + ")(?![0-9.,])|(?<![0-9.,])(" + NUMBER + ")\\s*元", Pattern.CASE_INSENSITIVE);
    // Unmarked numeric values are accepted only on explicit “金额:” fields, never after “消费”.
    private static final Pattern LABELED = Pattern.compile("(?:付款金额|支付金额|消费金额|交易金额|扣款金额|收款金额|到账金额|入账金额|收入金额|支出金额)\\s*[:：]\\s*(" + NUMBER + ")(?![0-9.,])(?=\\s*(?:元|$|[\\n，。；;]))", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAIL = Pattern.compile("(?:尾号|尾数|末四位|末4位|卡号尾号)\\s*[:：*＊]?\\s*([0-9]{4})(?![0-9])");
    private static final Pattern REF = Pattern.compile("(?:交易单号|交易订单号|订单号|流水号)\\s*[:：]\\s*([A-Za-z0-9_-]{6,80})");
    private static final Pattern MERCHANT = Pattern.compile("(?:商户(?:名称)?|收款方|付款给|商品说明)\\s*[:：]\\s*([^\\n，。；;]{1,60})");
    private static boolean has(String text, String... words) { for (String word : words) if (text.contains(word)) return true; return false; }
    private static String clip(String value, int max) { return value.length() > max ? value.substring(0, max) : value; }
    private static long cents(String raw) {
        try { long n = new BigDecimal(raw.replace(",", "")).movePointRight(2).longValueExact(); return n > 0 && n <= 1_000_000_000_000L ? n : 0; }
        catch (Exception e) { return 0; }
    }
    public static Parsed parse(String source, String notificationTitle, String body) {
        if (body == null) return null;
        String title = notificationTitle == null ? "" : notificationTitle.trim();
        String text = clip((title + "\n" + body).replace('\u00a0', ' '), 2400);
        boolean walletWechat = "com.tencent.mm".equals(source);
        boolean sms = source.contains("mms") || source.contains("messaging") || source.contains("message");
        // A chat saying “支付成功” is not a payment receipt. Only payment-service titles qualify.
        if (walletWechat && !(title.equals("微信支付") || title.equals("微信收款助手") || title.equals("微信收款商业版") || title.equals("收款通知"))) return null;
        if (sms && !Pattern.compile("(?:95[0-9]{3,8}|银行|信用卡|银联)").matcher(text).find()) return null;
        if (!has(text, "支付", "付款", "消费", "扣款", "支出", "收款", "到账", "入账", "收入", "转账", "转入", "转出", "退款", "退回", "支取")) return null;
        if (has(text, "验证码", "动态密码", "校验码", "一次性密码", "验证码已隐藏")) return null;
        if (has(text, "支付失败", "付款失败", "交易失败", "扣款失败", "待付款", "待支付", "等待付款", "待扣款", "即将扣款", "预计扣款", "扣款提醒", "支付提醒", "请付款", "请支付", "优惠券", "满减", "立减", "最高可", "支付请求", "申请退款", "退款申请", "退款中", "消费满", "消费达", "消费即可", "消费可享", "返现活动", "免息", "限时优惠", "支付立返", "支付有礼")) return null;
        if (has(text, "累计消费", "累计支出", "本月消费", "上月消费", "月度账单", "本月账单", "本期账单", "消费总额", "消费统计", "消费报告", "本月共", "本周共", "今日共", "账单已出", "待还金额", "应还金额")) return null;
        if (has(text, "预计", "即将", "将于", "预约", "预授权", "待入账", "待到账", "余额不足", "未成功", "未完成", "交易取消", "已取消", "支付取消", "交易关闭")) return null;
        Parsed result = new Parsed();
        // Exclude balances and limits before extracting the transaction amount.
        String amountsText = text.replaceAll("(?:可用余额|账户余额|余额|可用额度|剩余额度|授信额度)\\s*[:：]?\\s*(?:人民币|RMB|CNY|[¥￥])?\\s*[0-9][0-9,]*(?:\\.[0-9]{1,2})?\\s*元?", "");
        Set<Long> values = new LinkedHashSet<>();
        Matcher money = MONEY.matcher(amountsText);
        while (money.find()) { long n = cents(money.group(1) != null ? money.group(1) : money.group(2)); if (n > 0) values.add(n); }
        Matcher labeled = LABELED.matcher(amountsText);
        while (labeled.find()) { long n = cents(labeled.group(1)); if (n > 0) values.add(n); }
        if (values.isEmpty()) return null;
        result.amount = values.iterator().next();
        String directionText = text.replace("收款方", "商户").replace("收款人", "商户");
        boolean income = has(directionText, "收款", "到账", "入账", "收入", "转入");
        boolean expense = has(text, "支付成功", "付款成功", "消费", "扣款", "支出", "支取", "付款金额", "支付金额", "转出");
        result.type = income && !expense ? "income" : "expense";
        Matcher tail = TAIL.matcher(text); if (tail.find()) result.lastFour = tail.group(1);
        Matcher ref = REF.matcher(text); if (ref.find()) result.reference = ref.group(1);
        Matcher merchant = MERCHANT.matcher(text); if (merchant.find()) result.merchant = merchant.group(1).trim();
        result.title = !result.merchant.isEmpty() ? clip(result.merchant, 120) : (result.type.equals("income") ? "通知收款" : "通知付款");
        result.category = category(result.merchant + " " + text, result.type);
        result.snippet = clip(text, 360).replaceAll("(?<![0-9])[0-9]{12,19}(?![0-9])", "[号码已隐藏]");
        if (values.size() != 1) result.reason = "通知包含多个金额，请核对实际交易金额";
        else if (Pattern.compile("(?:人民币|RMB|CNY|[¥￥])\\s*[-−－]\\s*[0-9]|[-−－]\\s*(?:人民币|RMB|CNY|[¥￥])\\s*[0-9]|[-−－]\\s*[0-9]+(?:\\.[0-9]+)?\\s*元").matcher(amountsText).find()) result.reason = "通知使用负金额，请核对实际金额和收支方向";
        else if (sms && (!title.matches("(?:\\+?86)?95[0-9]{3,8}") || result.lastFour.isEmpty())) result.reason = "短信发送者或银行卡信息尚未确认，请核对交易";
        else if (has(text, "USD", "US$", "$", "美元", "日元", "欧元", "港币", "港元", "英镑", "JPY", "EUR", "HKD")) result.reason = "通知可能是外币交易，请核对币种";
        else if (has(text, "退款", "退回", "撤销", "冲正", "转账", "转入", "转出", "还款", "充值", "提现")) result.reason = "退款、转账或还款需要确认，避免重复统计收支";
        else if (income && expense) result.reason = "通知的收支方向不明确";
        else if (!income && !expense) result.reason = "请确认交易已经完成及收支方向";
        else if ("com.eg.android.AlipayGphone".equals(source) && !has(text, "成功", "已支付", "已付款", "已到账", "到账", "收款")) result.reason = "请确认支付宝交易已完成";
        else result.confident = true;
        return result;
    }
    private static String category(String text, String type) {
        if ("income".equals(type)) return has(text, "工资", "薪资") ? "工资薪资" : "其他收入";
        if (has(text, "咖啡", "奶茶", "餐", "饭", "外卖", "美团", "饿了么")) return "餐饮美食";
        if (has(text, "地铁", "公交", "打车", "滴滴", "高铁", "火车", "停车", "加油")) return "交通出行";
        if (has(text, "超市", "便利店", "淘宝", "京东", "拼多多", "购物")) return "购物消费";
        if (has(text, "会员", "订阅", "ChatGPT", "Claude", "Gemini")) return "会员订阅";
        if (has(text, "话费", "水费", "电费", "燃气", "宽带")) return "居住生活";
        return "其他支出";
    }
}
