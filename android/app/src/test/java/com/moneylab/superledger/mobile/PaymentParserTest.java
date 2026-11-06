package com.moneylab.superledger.mobile;

/** Pure Java regression harness: java -ea ...PaymentParserTest. No device data required. */
public final class PaymentParserTest {
    private static int cases;
    private static PaymentParser.Parsed parse(String title, String body) { return PaymentParser.parse("com.tencent.mm", title, body); }
    private static void check(boolean condition, String label) { cases++; if (!condition) throw new AssertionError(label); }
    public static void main(String[] args) {
        PaymentParser.Parsed payment = parse("微信支付", "支付成功\n付款金额：￥28.00\n收款方：好吃餐厅");
        check(payment != null && payment.confident && payment.amount == 2800 && payment.type.equals("expense"), "payment receipt with payee label");
        check(payment.category.equals("餐饮美食"), "desktop category consistency");
        check(parse("张三", "支付成功28元，我转你了") == null, "private chat never parsed");
        check(parse("微信支付", "支付失败28.00元") == null, "failed payment ignored");
        check(parse("微信支付", "待支付28元，请付款") == null, "unpaid request ignored");
        check(parse("微信支付", "即将扣款28元") == null, "future debit ignored");
        check(parse("微信支付", "支付验证码123456，金额28元") == null, "OTP ignored");
        check(parse("微信支付", "支付成功，消费2026年11月5日") == null, "date not interpreted as amount");
        check(parse("微信支付", "消费满300元返现30元") == null, "marketing threshold ignored");
        check(parse("微信支付", "支付有礼，28元免息活动") == null, "installment marketing ignored");
        PaymentParser.Parsed bank = PaymentParser.parse("cmb.pb", "账户变动", "您尾号1234账户消费人民币28.00，账户余额人民币1234.00元");
        check(bank != null && bank.confident && bank.amount == 2800 && bank.lastFour.equals("1234"), "bank balance excluded");
        PaymentParser.Parsed income = PaymentParser.parse("com.eg.android.AlipayGphone", "支付宝", "收款到账88.80元");
        check(income != null && income.confident && income.amount == 8880 && income.type.equals("income"), "income receipt");
        PaymentParser.Parsed refund = parse("微信支付", "退款到账28.00元");
        check(refund != null && !refund.confident && refund.reason.contains("退款"), "refund awaits review");
        PaymentParser.Parsed transfer = parse("微信支付", "转账成功28.00元");
        check(transfer != null && !transfer.confident, "transfer awaits review");
        PaymentParser.Parsed multiple = parse("微信支付", "支付成功28.00元，服务费2.00元");
        check(multiple != null && !multiple.confident, "multiple amounts await review");
        PaymentParser.Parsed foreign = parse("微信支付", "支付成功USD 28.00，折合人民币200.00元");
        check(foreign != null && !foreign.confident, "foreign currency awaits review");
        PaymentParser.Parsed field = parse("微信支付", "支付成功\n付款金额：28.00\n订单号：20261105123456");
        check(field != null && field.confident && field.amount == 2800, "explicit amount field");
        check(parse("微信支付", "支付成功，订单号20261105123456") == null, "order ID not interpreted as amount");
        PaymentParser.Parsed thousands = PaymentParser.parse("cmb.pb", "消费通知", "尾号1234消费人民币1,234.56元，余额8,000.00元");
        check(thousands != null && thousands.amount == 123456 && thousands.confident, "grouped monetary amount");
        check(PaymentParser.parse("cmb.pb", "消费统计", "本月累计消费100元") == null, "monthly summary ignored");
        PaymentParser.Parsed sms = PaymentParser.parse("com.android.mms", "朋友", "今天银行卡消费了100元");
        check(sms != null && !sms.confident, "unverified SMS sender awaits review");
        PaymentParser.Parsed bankSms = PaymentParser.parse("com.android.mms", "95555", "您尾号1234消费人民币28.00元，余额1000元");
        check(bankSms != null && bankSms.confident && bankSms.amount == 2800, "identified bank SMS template");
        check(parse("微信支付", "支付成功￥12.345元") == null, "overprecision amount never sliced");
        PaymentParser.Parsed negative = parse("微信支付", "支付成功-10元");
        check(negative != null && !negative.confident, "negative amount awaits review");
        PaymentParser.Parsed dated = PaymentParser.parse("cmb.pb", "消费通知", "2026-11-05您尾号1234消费人民币28.00元");
        check(dated != null && dated.confident, "ISO date not mistaken for negative money");
        check(parse("微信支付", "付款金额28元，余额不足") == null, "insufficient balance ignored");
        check(PaymentParser.parse("cmb.pb", "到账提醒", "预计收入100元") == null, "projected income ignored");
        System.out.println("PaymentParser: " + cases + " checks passed");
    }
}
