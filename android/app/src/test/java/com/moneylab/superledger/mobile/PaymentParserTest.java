package com.moneylab.superledger.mobile;

/** Synthetic receipts only; these are not captured notifications or real bank templates. */
public final class PaymentParserTest {
    private static int cases;
    private static PaymentParser.Parsed parse(String title, String body) { return PaymentParser.parse("com.tencent.mm", title, body); }
    private static String bankCard(String amount,String account,String content) { return "交易提醒\n交易金额 "+amount+"\n账号 "+account+"\n交易时间 11月12日07:27\n交易内容 "+content+"\n账户余额 2,606.39元\n银行名称 工商银行"; }
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
        PaymentParser.Parsed grocery=parse("付款通知","付款成功\n商户：青禾生鲜超市\n原价：30.00元\n优惠：2.00元\n实付金额：28.00元\n付款方式：零钱");
        check(grocery!=null&&grocery.confident&&grocery.amount==2800&&grocery.amountBasis.equals("actual"),"discount grocery actual payment");
        check(grocery.fundingSource.equals("wallet")&&grocery.paymentChannel.equals("wechat")&&grocery.merchant.equals("青禾生鲜超市"),"wallet merchant evidence");
        check(grocery.category.equals("购物消费"),"grocery uses normal shopping category");
        PaymentParser.Parsed bound=parse("微信支付","扫码付款成功\n商家名称：青禾摊位\n订单金额：50元\n立减：3元\n实付：47元\n付款方式：招商银行(1234)\n订单号：SYNTHETIC001");
        check(bound!=null&&bound.confident&&bound.amount==4700,"bound card QR actual amount");
        check(bound.fundingSource.equals("bank")&&bound.bankId.equals("cmb")&&bound.lastFour.equals("1234"),"bank name and bracket tail");
        check(bound.reference.equals("SYNTHETIC001")&&bound.category.equals("其他支出"),"reference and no guessed grocery category");
        PaymentParser.Parsed ali=PaymentParser.parse("com.eg.android.AlipayGphone","支付助手","付款成功\n付款金额：￥18.80\n原价：20元\n已优惠：1.20元\n商户名称：青禾便利店\n支付方式：余额宝");
        check(ali!=null&&ali.confident&&ali.amount==1880&&ali.fundingSource.equals("wallet"),"Alipay discount receipt");
        PaymentParser.Parsed debit=PaymentParser.parse("cmb.pb","扣款提醒","您尾号1234银行卡通过微信支付消费人民币28.00元，商户：青禾生鲜，账户余额1234元");
        check(debit!=null&&debit.confident&&debit.amount==2800&&debit.paymentChannel.equals("wechat")&&debit.fundingSource.equals("bank"),"actual bank debit survives reminder title");
        check(PaymentParser.parse("cmb.pb","扣款提醒","将于明天扣款28元")==null,"reminder without completed event ignored");
        PaymentParser.Parsed multi=parse("微信支付","付款成功\n付款金额：28元\n另一笔消费：32元");
        check(multi!=null&&multi.amount==0&&!multi.confident&&multi.amountCandidates.size()==2,"unrelated second amount never first selected");
        PaymentParser.Parsed twoActual=parse("微信支付","支付成功\n实付：28元\n实付：32元");
        check(twoActual!=null&&twoActual.amount==0&&!twoActual.confident,"conflicting actual fields");
        PaymentParser.Parsed feeTotal=parse("微信支付","支付成功\n交易金额：28元\n服务费：2元\n实际扣款：30元");
        check(feeTotal!=null&&feeTotal.confident&&feeTotal.amount==3000,"explicit total resolves fee");
        check(multiple.amount==0&&multiple.amountCandidates.contains(200L),"fee ambiguity retained as candidates");
        check(parse("微信支付","付款成功\n原价：10元\n优惠：10元\n实付：0元")==null,"zero actual does not book original");
        check(parse("微信支付","付款成功\n余额：100元")==null,"balance alone is not payment");
        PaymentParser.Parsed noFunding=parse("微信支付","付款成功28元，账户余额100元");
        check(noFunding!=null&&noFunding.amount==2800&&noFunding.fundingSource.equals("unknown"),"balance amount is not payment method");
        PaymentParser.Parsed unknown=PaymentParser.parse("example.untrusted.bank","消费通知","付款成功28元，招商银行尾号1234");
        check(unknown!=null&&!unknown.knownSource&&!unknown.confident,"unrecognized source remains review");
        check(PaymentParser.parse("com.eg.android.AlipayGphone","张三","支付成功28元")==null,"Alipay chat ignored");
        check(parse("微信支付","支付成功后可获得28元优惠券")==null,"conditional marketing ignored");
        check(parse("微信支付","支付验证码：123456，实付金额28元")==null,"OTP never stored");
        PaymentParser.Parsed recharge=parse("微信支付","充值成功\n支付成功20元");
        check(recharge!=null&&!recharge.confident&&recharge.transactionKind.equals("recharge"),"recharge reviewed");
        PaymentParser.Parsed withdrawal=PaymentParser.parse("com.eg.android.AlipayGphone","支付宝","提现到账20元");
        check(withdrawal!=null&&!withdrawal.confident&&withdrawal.transactionKind.equals("withdrawal"),"withdrawal reviewed");
        PaymentParser.Parsed repayment=parse("微信支付","信用卡还款成功\n支付金额：20元");
        check(repayment!=null&&!repayment.confident&&repayment.transactionKind.equals("repayment"),"repayment reviewed");
        PaymentParser.Parsed mixed=parse("微信支付","付款成功28元\n付款方式：零钱\n付款方式：招商银行(1234)");
        check(mixed!=null&&mixed.ambiguousFunding&&!mixed.confident,"mixed funding reviewed");
        PaymentParser.Parsed tails=parse("微信支付","支付成功28元\n付款方式：银行卡 尾号1234和尾号5678");
        check(tails!=null&&tails.ambiguousFunding&&tails.lastFour.isEmpty(),"multiple card tails never first selected");
        PaymentParser.Parsed masked=parse("微信支付","付款成功28元\n支付方式：工商银行 ****0088");
        check(masked!=null&&masked.bankId.equals("icbc")&&masked.lastFour.equals("0088"),"masked tail preserves leading zero");
        PaymentParser.Parsed fullWidth=parse("微信支付","付款成功\n实付：￥２８．５０\n付款方式：零钱");
        check(fullWidth!=null&&fullWidth.amount==2850,"full width numeric amount");
        check(parse("微信支付","支付成功￥12.345元，原价20元")==null,"invalid actual does not use original");
        PaymentParser.Parsed foreignActual=parse("微信支付","支付成功\n实付：100元\n币种：HKD");
        check(foreignActual!=null&&!foreignActual.confident&&foreignActual.amount==0,"foreign actual requires currency confirmation");
        PaymentParser.Parsed merchantBank=parse("微信支付","付款成功28元\n商户：招商银行食堂\n付款方式：零钱");
        check(merchantBank!=null&&merchantBank.fundingSource.equals("wallet")&&merchantBank.bankId.isEmpty(),"bank in merchant name is not funding bank");
        PaymentParser.Parsed phoneTail=parse("微信支付","付款成功28元\n手机尾号1234\n订单尾号5678\n付款方式：零钱");
        check(phoneTail!=null&&phoneTail.lastFour.isEmpty(),"phone and order tails excluded");
        PaymentParser.Parsed unknownCard=parse("微信支付","支付成功28元\n支付方式：银行卡(1234)");
        check(unknownCard!=null&&unknownCard.lastFour.equals("1234")&&unknownCard.bankId.isEmpty(),"generic bank card tail");
        PaymentParser.Parsed credit=PaymentParser.parse("com.eg.android.AlipayGphone","支付宝","付款成功28元\n支付方式：花呗");
        check(credit!=null&&credit.fundingSource.equals("credit"),"credit facility distinct from cash wallet");
        PaymentParser.Parsed clipped=parse("微信支付","付款成功28元\n[通知内容已截断]");
        check(clipped!=null&&!clipped.confident,"truncated text always reviewed");
        check(PaymentParser.parse(null,"付款通知","支付成功28元")!=null,"null source remains safe review");
        check(parse("微信支付","付款成功\n原价28元\n优惠2元")==null,"no actual payment inferred by subtraction");
        PaymentParser.Parsed comma=parse("微信支付","付款成功,实付：￥28.50,余额：￥100.00");
        check(comma!=null&&comma.confident&&comma.amount==2850,"ASCII field punctuation is not thousands separator");
        check(parse("微信支付","付款成功￥12,34元")==null,"malformed grouping never sliced");
        check(PaymentParser.parse("cmb.pb","消费提醒","尾号1234消费失败28元")==null,"failed card consumption ignored");
        check(PaymentParser.parse("cmb.pb","扣款提醒","尾号1234消费限额1000元")==null,"card limit is not a transaction");
        PaymentParser.Parsed reminder=PaymentParser.parse("cmb.pb","扣款提醒","尾号1234自动扣款服务，100元");
        check(reminder!=null&&!reminder.confident&&!reminder.completed,"reminder title is not completion evidence");
        check(parse("微信支付","支付处理中28元")==null,"processing payment ignored");
        check(parse("微信支付","支付成功，即可领取28元红包")==null,"conditional reward is not paid amount");
        PaymentParser.Parsed twoOrders=parse("微信支付","支付成功28元\n订单号：SYNTHETIC001\n订单号：SYNTHETIC002");
        check(twoOrders!=null&&!twoOrders.confident&&twoOrders.reference.isEmpty(),"multiple orders not reduced to first reference");
        String structured=bankCard("28.39元","1234","支出(消费拼多多支付-拼多多平台商户)");
        for(String sender:new String[]{"95588","+8695588","工商银行","中国工商银行","工商银行（2条新短信）"}){
            PaymentParser.Parsed card=PaymentParser.parse("com.android.mms",sender,structured);
            check(card!=null&&card.confident&&card.completed&&card.amount==2839,"structured bank consumption: "+sender);
            check(card.bankId.equals("icbc")&&card.lastFour.equals("1234")&&card.fundingSource.equals("bank"),"structured card routes by bank and four-digit account: "+sender);
            check(card.type.equals("expense")&&card.transactionKind.equals("payment")&&card.amountCandidates.size()==1,"bank balance excluded from consumption: "+sender);
        }
        PaymentParser.Parsed penny=PaymentParser.parse("com.android.mms","95588",bankCard("0.01元","0088","支出(消费抖音支付-抖音支付券包售卖)"));
        check(penny!=null&&penny.confident&&penny.amount==1&&penny.lastFour.equals("0088"),"one-cent SMS and leading-zero card account");
        PaymentParser.Parsed splitFields=PaymentParser.parse("com.android.mms","95588",structured.replace("交易金额 ","交易金额\n").replace("账号 ","账号\n").replace("平台商户)","平台\n商户)"));
        check(splitFields!=null&&splitFields.confident&&splitFields.amount==2839&&splitFields.lastFour.equals("1234"),"bank fields and consumption detail can wrap across lines");
        PaymentParser.Parsed colonFields=PaymentParser.parse("com.android.mms","95588",structured.replace("交易金额 ","交易金额：").replace("账号 ","账号：").replace("交易内容 ","交易内容："));
        check(colonFields!=null&&colonFields.confident,"bank card field colons optional");
        PaymentParser.Parsed unitless=PaymentParser.parse("com.android.mms","95588",bankCard("28.39","1234","支出(消费拼多多支付)"));
        check(unitless!=null&&unitless.confident&&unitless.amount==2839,"explicit structured transaction amount may omit unit");
        for(String sender:new String[]{"朋友","工商银行客服","955880","陌生95588"}){
            PaymentParser.Parsed unknownBank=PaymentParser.parse("com.android.mms",sender,structured);
            check(unknownBank!=null&&!unknownBank.knownSource&&!unknownBank.confident&&unknownBank.lastFour.isEmpty(),"display sender must exactly identify bank: "+sender);
        }
        PaymentParser.Parsed longAccount=PaymentParser.parse("com.android.mms","95588",bankCard("28.39元","6222000012345678","支出(消费拼多多支付)"));
        check(longAccount!=null&&!longAccount.confident&&longAccount.lastFour.isEmpty(),"full account number is never sliced to four digits");
        for(String account:new String[]{"6222\n0000\n1234\n5678","6222 0000 1234 5678","6222\t000012345678"}){
            PaymentParser.Parsed splitLongAccount=PaymentParser.parse("com.android.mms","95588",bankCard("28.39元",account,"支出(消费拼多多支付)"));
            check(splitLongAccount!=null&&!splitLongAccount.confident&&splitLongAccount.lastFour.isEmpty(),"grouped full card account never becomes first four-digit group");
        }
        PaymentParser.Parsed mixedAccount=PaymentParser.parse("com.android.mms","95588",structured+"\n另一张卡尾号5678");
        check(mixedAccount!=null&&!mixedAccount.confident&&mixedAccount.ambiguousFunding&&mixedAccount.lastFour.isEmpty(),"structured account conflicts with different explicit tail");
        PaymentParser.Parsed twoCards=PaymentParser.parse("com.android.mms","95588",structured+"\n账号 5678");
        check(twoCards!=null&&!twoCards.confident&&twoCards.amount==0,"multiple independent account fields require review");
        PaymentParser.Parsed multipleBank=PaymentParser.parse("com.android.mms","95588",structured+"\n建设银行尾号1234");
        check(multipleBank!=null&&!multipleBank.confident&&multipleBank.ambiguousFunding,"bank identity conflicts remain reviewable");
        PaymentParser.Parsed twoBankAmounts=PaymentParser.parse("com.android.mms","95588",structured+"\n交易金额 28.39元");
        check(twoBankAmounts!=null&&!twoBankAmounts.confident&&twoBankAmounts.amount==0,"duplicate same-valued transaction amount fields are not merged into one debit");
        PaymentParser.Parsed twoBankContents=PaymentParser.parse("com.android.mms","95588",structured+"\n交易内容 支出(消费另一商户)");
        check(twoBankContents!=null&&!twoBankContents.confident&&twoBankContents.amount==0,"multiple consumption fields never auto-book as one payment");
        String secondStructured=structured.replace("07:27","08:27").replace("2,606.39","2,578.00");
        java.util.Set<String> mergedLines=new java.util.LinkedHashSet<>();for(String line:(structured+"\n"+secondStructured).split("\n"))mergedLines.add(line);
        PaymentParser.Parsed mergedCards=PaymentParser.parse("com.android.mms","95588",String.join("\n",mergedLines));
        check(mergedCards!=null&&!mergedCards.confident&&mergedCards.amount==0,"line-deduplicated merged cards retain separate transaction evidence");
        PaymentParser.Parsed twoTimes=PaymentParser.parse("com.android.mms","95588",structured+"\n交易时间 11月12日08:27");
        check(twoTimes!=null&&!twoTimes.confident&&twoTimes.amount==0,"different transaction times cannot be one structured debit");
        PaymentParser.Parsed twoBalances=PaymentParser.parse("com.android.mms","95588",structured+"\n账户余额 2578元");
        check(twoBalances!=null&&!twoBalances.confident&&twoBalances.amount==0,"different balance fields cannot be one structured debit");
        PaymentParser.Parsed noContent=PaymentParser.parse("com.android.mms","95588",structured.replace("交易内容 支出(消费拼多多支付-拼多多平台商户)","消费信息待核对"));
        check(noContent!=null&&!noContent.confident&&!noContent.completed&&noContent.lastFour.isEmpty(),"amount and account without structured content are not completion evidence");
        check(PaymentParser.parse("com.android.mms","95588",structured.replace("交易金额 28.39元\n", ""))==null,"balance alone cannot fill a missing transaction amount");
        check(PaymentParser.parse("com.android.mms","工商银行","收到一条新短信")==null,"notification placeholder contains no bank payment evidence");
        check(PaymentParser.parse("com.android.mms","95588",structured+"\n验证码123456")==null,"structured bank OTP remains ignored");
        check(PaymentParser.parse("com.android.mms","95588",structured+"\n交易失败")==null,"structured failed debit remains ignored");
        check(PaymentParser.parse("com.android.mms","95588",structured+"\n预计明天扣款")==null,"structured scheduled debit remains ignored");
        PaymentParser.Parsed bankRefund=PaymentParser.parse("com.android.mms","95588",bankCard("28.39元","1234","收入(消费退款到账)"));
        check(bankRefund!=null&&!bankRefund.confident&&bankRefund.transactionKind.equals("refund"),"structured bank refund requires review");
        PaymentParser.Parsed bankTransfer=PaymentParser.parse("com.android.mms","95588",bankCard("28.39元","1234","支出(转账汇款)"));
        check(bankTransfer!=null&&!bankTransfer.confident&&bankTransfer.transactionKind.equals("transfer"),"structured bank transfer requires review");
        String rawBank="您尾号1234储蓄卡11月12日07:27支出(消费拼多多支付-拼多多平台商户)28.39元，余额2,606.39元。【工商银行】";
        for(String sender:new String[]{"95588","工商银行"}){
            PaymentParser.Parsed rawConsumption=PaymentParser.parse("com.android.mms",sender,rawBank);
            check(rawConsumption!=null&&rawConsumption.confident&&rawConsumption.completed&&rawConsumption.amount==2839&&rawConsumption.lastFour.equals("1234"),"natural-language bank consumption is a completed debit: "+sender);
        }
        PaymentParser.Parsed rawPenny=PaymentParser.parse("com.android.mms","95588",rawBank.replace("28.39元","0.01元"));
        check(rawPenny!=null&&rawPenny.confident&&rawPenny.amount==1,"one-cent natural-language consumption");
        PaymentParser.Parsed rawSplit=PaymentParser.parse("com.android.mms","95588",rawBank.replace("平台商户)","平台\n商户)"));
        check(rawSplit!=null&&rawSplit.confident&&rawSplit.amount==2839,"natural-language consumption can wrap within detail");
        PaymentParser.Parsed twoRaw=PaymentParser.parse("com.android.mms","95588",rawBank+"\n"+rawBank);
        check(twoRaw!=null&&!twoRaw.confident&&twoRaw.amount==0,"two identical natural-language debits remain separate review work");
        PaymentParser.Parsed mixedFormats=PaymentParser.parse("com.android.mms","95588",structured+"\n"+rawBank);
        check(mixedFormats!=null&&!mixedFormats.confident&&mixedFormats.amount==0,"mixed structured and natural-language receipts require review");
        PaymentParser.Parsed rawUnknown=PaymentParser.parse("com.android.mms","朋友",rawBank);
        check(rawUnknown!=null&&!rawUnknown.confident&&!rawUnknown.completed,"bank name in body never verifies unknown sender");
        check(PaymentParser.parse("com.android.mms","95588",rawBank+"\n交易失败")==null,"failed natural-language debit remains ignored");
        check(PaymentParser.parse("com.android.mms","95588",rawBank+"\n即将扣款")==null,"scheduled natural-language debit remains ignored");
        for(String notPaid:new String[]{"尚未支出","待支出","计划支出"}){
            check(PaymentParser.parse("com.android.mms","95588",rawBank.replace("支出(",notPaid+"("))==null,"natural-language uncompleted consumption is ignored: "+notPaid);
            check(PaymentParser.parse("com.android.mms","95588",structured.replace("支出(",notPaid+"("))==null,"structured uncompleted consumption is ignored: "+notPaid);
        }
        System.out.println("PaymentParser: " + cases + " checks passed");
    }
}
