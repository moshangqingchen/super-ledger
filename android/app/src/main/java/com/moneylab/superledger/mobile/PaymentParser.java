package com.moneylab.superledger.mobile;

import java.math.BigDecimal;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Local-only parser. Text confidence and account routing are separate decisions. */
public final class PaymentParser {
    private PaymentParser() {}
    public static final class Parsed {
        public long amount;
        public String type="expense", title="", category="其他支出", lastFour="", reference="", merchant="", reason="", snippet="";
        public String paymentChannel="unknown", fundingSource="unknown", bankId="", bankName="", fundingLabel="", transactionKind="unknown", amountBasis="unknown", captureMethod="notification";
        public boolean confident, completed, knownSource, ambiguousFunding;
        public final List<Long> amountCandidates=new ArrayList<>();
    }
    private static final String NUMBER="(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?";
    private static final String LABEL="实际支付金额|实际付款金额|实际扣款金额|实际到账金额|实付金额|实际支付|实际付款|实际扣款|实际到账|合计支付|合计付款|扣款合计|实付|付款金额|支付金额|消费金额|交易金额|扣款金额|收款金额|到账金额|入账金额|收入金额|支出金额";
    private static final Pattern MONEY=Pattern.compile("(?:人民币|RMB|CNY|[¥￥])\\s*("+NUMBER+")(?![0-9.]|,[0-9])|(?<![0-9.,])("+NUMBER+")\\s*元",Pattern.CASE_INSENSITIVE);
    private static final Pattern LABELED=Pattern.compile("("+LABEL+")\\s*[:：]\\s*("+NUMBER+")(?![0-9.]|,[0-9])(?=\\s*(?:元|$|[\\n,，。；;]))");
    private static final Pattern TAIL=Pattern.compile("(?:尾号|尾数|末四位|末4位|卡号尾号)\\s*[:：*＊]?\\s*([0-9]{4})(?![0-9])|[*＊]{2,}\\s*([0-9]{4})(?![0-9])");
    private static final Pattern REF=Pattern.compile("(?:交易单号|交易订单号|订单号|流水号)\\s*[:：]\\s*([A-Za-z0-9_-]{6,80})(?![A-Za-z0-9_-])");
    private static final Pattern MERCHANT=Pattern.compile("(?:商户(?:名称|全称)?|收款方|收款商家|商家(?:名称)?|付款给|商品说明)\\s*[:：]\\s*([^\\n，。；;]{1,80})");
    private static final Pattern METHOD=Pattern.compile("(?:付款方式|支付方式|扣款账户|付款账户|资金来源)\\s*[:：]\\s*([^\\n，。；;]{1,70})");
    private static final String BANK_FIELD_START="(?:^|[\\s，,；;])";
    private static final Pattern BANK_AMOUNT_LABEL=Pattern.compile(BANK_FIELD_START+"交易金额\\s*[:：]?");
    private static final Pattern BANK_CONTENT_LABEL=Pattern.compile(BANK_FIELD_START+"交易内容\\s*[:：]?");
    private static final Pattern BANK_TIME_LABEL=Pattern.compile(BANK_FIELD_START+"交易时间\\s*[:：]?");
    private static final Pattern BANK_BALANCE_LABEL=Pattern.compile(BANK_FIELD_START+"账户余额\\s*[:：]?");
    private static final Pattern BANK_AMOUNT=Pattern.compile(BANK_FIELD_START+"交易金额\\s*[:：]?\\s*(?:人民币|RMB|CNY|[¥￥])?\\s*("+NUMBER+")(?![0-9.]|,[0-9])(?=\\s*(?:元|$|[\\n,，。；;]))",Pattern.CASE_INSENSITIVE);
    private static final Pattern BANK_ACCOUNT=Pattern.compile(BANK_FIELD_START+"(?:账号|卡号)\\s*[:：]?\\s*([0-9]{4})(?!\\s*[0-9])(?=\\s*(?:$|[\\n,，。；;]|交易(?:时间|内容|金额)|账户余额|银行名称))");
    private static final Pattern BANK_CONSUMPTION=Pattern.compile(BANK_FIELD_START+"交易内容\\s*[:：]?\\s*支出\\s*[(]\\s*消费[^)]{0,160}[)]");
    private static final Pattern BANK_RAW_CONSUMPTION=Pattern.compile("支出\\s*[(]\\s*消费[^)]{0,160}[)]\\s*(?:人民币|RMB|CNY|[¥￥])?\\s*("+NUMBER+")(?![0-9.]|,[0-9])\\s*元",Pattern.CASE_INSENSITIVE);
    private static final String[][] BANKS={
        {"icbc","工商银行","中国工商银行|工商银行|工行","com.icbc","95588"},
        {"ccb","建设银行","中国建设银行|建设银行|建行","com.chinamworld.main","95533"},
        {"abc","农业银行","中国农业银行|农业银行|农行","com.android.bankabc","95599"},
        {"cmb","招商银行","招商银行|招行","cmb.pb","95555"},
        {"boc","中国银行","中国银行|中行","com.chinamworld.bocmbci","95566"},
        {"bocom","交通银行","交通银行|交行","com.bankcomm.Bankcomm","95559"},
        {"psbc","邮储银行","中国邮政储蓄银行|邮政储蓄银行|邮储银行|邮储","com.yitong.mbank.psbc","95580"},
        {"pingan","平安银行","平安银行","com.pingan.paces.ccms","95511"},
        {"citic","中信银行","中信银行","com.ecitic.bank.mobile","95558"},
        {"cib","兴业银行","兴业银行","com.cib.cibmb","95561"},
        {"spdb","浦发银行","浦发银行|浦东发展银行","cn.com.spdb.mobilebank.per","95528"},
        {"cmbc","民生银行","民生银行","cn.com.cmbc.newmbank","95568"}
    };
    static boolean has(String text,String... words){for(String word:words)if(text.contains(word))return true;return false;}
    static String normalize(String value){return Normalizer.normalize((value==null?"":value).replace('，','\uE000').replace('；','\uE001'),Normalizer.Form.NFKC).replace('\uE000','，').replace('\uE001','；').replace('\u00a0',' ').replaceAll("[\\u200B-\\u200D\\uFEFF]","").trim();}
    private static String clip(String value,int max){return value.length()>max?value.substring(0,max):value;}
    private static long cents(String raw){try{long n=new BigDecimal(raw.replace(",","")).movePointRight(2).longValueExact();return n>=0&&n<=1_000_000_000_000L?n:-1;}catch(Exception e){return -1;}}
    private static final class Amount {long value;int rank;String basis;boolean fee;Amount(long n,int r,String b,boolean f){value=n;rank=r;basis=b;fee=f;}}
    private static final class BankNotice {
        final List<Amount> amounts=new ArrayList<>();
        final Set<String> tails=new LinkedHashSet<>();
        boolean completed,multiple;
    }
    private static int matches(Pattern pattern,String text){int count=0;Matcher matcher=pattern.matcher(text);while(matcher.find())count++;return count;}
    /** Bank card fields and natural-language consumption receipts require a recognized sender. */
    private static BankNotice bankNotice(String text,boolean bankSource){
        BankNotice notice=new BankNotice();if(!bankSource)return notice;
        int rawPayments=0;Matcher raw=BANK_RAW_CONSUMPTION.matcher(text);
        while(raw.find()){notice.amounts.add(new Amount(cents(raw.group(1)),3,"transaction",false));rawPayments++;}
        int amountFields=matches(BANK_AMOUNT_LABEL,text),contentFields=matches(BANK_CONTENT_LABEL,text);
        boolean structured=amountFields>0&&contentFields>0;int accounts=0;
        if(structured){
            Matcher amount=BANK_AMOUNT.matcher(text);while(amount.find())notice.amounts.add(new Amount(cents(amount.group(1)),3,"transaction",false));
            Matcher account=BANK_ACCOUNT.matcher(text);while(account.find()){notice.tails.add(account.group(1));accounts++;}
        }
        notice.multiple=rawPayments>1||amountFields>1||contentFields>1||accounts>1||matches(BANK_TIME_LABEL,text)>1||matches(BANK_BALANCE_LABEL,text)>1||(rawPayments>0&&structured);
        notice.completed=!notice.multiple&&notice.amounts.size()==1&&(rawPayments==1||structured&&BANK_CONSUMPTION.matcher(text).find());
        return notice;
    }
    private static Amount amount(String text,int start,String raw,String label){
        String before=label==null?text.substring(Math.max(0,start-24),start):label;
        int boundary=Math.max(Math.max(Math.max(before.lastIndexOf('\n'),before.lastIndexOf('，')),before.lastIndexOf(',')),Math.max(before.lastIndexOf(';'),before.lastIndexOf('；')));
        before=before.substring(boundary+1).replaceAll("[\\s:：=￥¥]+$","");
        if(before.matches(".*(?:可用余额|账户余额|钱包余额|余额|可用额度|剩余额度|授信额度|可用金额|剩余可用|剩余金额|余额为|限额|额度)$"))return new Amount(cents(raw),-2,"unknown",false);
        if(before.matches(".*(?:实际支付金额|实际付款金额|实际扣款金额|实际到账金额|实付金额|实际支付|实际付款|实际扣款|实际到账|合计支付|合计付款|扣款合计|实付)$"))return new Amount(cents(raw),4,has(before,"到账")?"credited":"actual",false);
        if(before.matches(".*(?:手续费|服务费|附加费|手续费金额|服务费金额)$"))return new Amount(cents(raw),-1,"unknown",true);
        if(before.matches(".*(?:原价|原金额|订单金额|商品金额|商品原价|优惠前|应付金额|优惠金额|已优惠|共优惠|优惠|优惠券|立减|满减|抵扣|红包抵扣|商家优惠|补贴|折扣|节省)$"))return new Amount(cents(raw),-1,"unknown",false);
        if(before.matches(".*(?:付款金额|支付金额|消费金额|交易金额|扣款金额|支出金额|收款金额|到账金额|入账金额|收入金额)$"))return new Amount(cents(raw),3,has(before,"到账","入账","收款","收入")?"credited":"transaction",false);
        return new Amount(cents(raw),1,"transaction",false);
    }
    public static Parsed parse(String source,String notificationTitle,String body){
        if(body==null)return null;
        source=source==null?"":source;String title=normalize(notificationTitle),text=normalize(title+"\n"+body);
        boolean truncated=text.length()>6000||text.contains("[通知内容已截断]");text=clip(text,6000);
        boolean wechat=source.equals("com.tencent.mm"),alipay=source.equals("com.eg.android.AlipayGphone");
        boolean sms=source.contains("mms")||source.contains("messaging")||source.contains("message");
        String cleanTitle=title.replaceFirst("\\s*[(][0-9]+条新消息[)]$","");
        String bankTitle=title.replaceFirst("\\s*[(][0-9]+条新(?:消息|短信)[)]$","");
        if(wechat&&!cleanTitle.matches("微信支付|微信支付凭证|微信收款助手|微信收款商业版|收款通知|付款通知|付款成功通知|支付通知|付款成功|支付成功"))return null;
        if(alipay&&!cleanTitle.matches("支付宝|支付宝通知|支付宝支付|支付助手|付款通知|支付通知|交易通知|收款通知|到账通知|付款成功|支付成功|商家服务|收钱到账"))return null;
        if(sms&&!Pattern.compile("95[0-9]{3,8}|银行|信用卡|银联").matcher(text).find())return null;
        if(!has(text,"支付","付款","消费","扣款","支出","收款","到账","入账","收入","转账","转入","转出","退款","退回","支取","充值","提现","还款"))return null;
        if(has(text,"验证码","动态密码","校验码","一次性密码","交易口令","短信口令"))return null;
        if(has(text,"失败","未支付","未付款","未扣款","未支出","待支出","计划支出","未入账","交易拒绝","消费拒绝","处理中","正在支付","正在付款"))return null;
        if(has(text,"支付失败","付款失败","交易失败","扣款失败","待付款","待支付","等待付款","待扣款","即将扣款","预计扣款","请付款","请支付","支付请求","申请退款","退款申请","退款中","预计","即将","将于","预约","预授权","待入账","待到账","余额不足","未成功","未完成","交易取消","已取消","支付取消","交易关闭"))return null;
        if(has(text,"累计消费","累计支出","本月消费","上月消费","月度账单","本月账单","本期账单","消费总额","消费统计","消费报告","本月共","本周共","今日共","账单已出","待还金额","应还金额"))return null;
        if(has(text,"消费满","消费达","消费即可","消费可享","返现活动","限时优惠","支付立返","支付有礼","最高可","成功后即可","成功后可","付款成功后","支付成功后","可享免息"))return null;
        if(Pattern.compile("(?:支付|付款|消费)成功[，,\\s]*(?:即可|送|可领|可得|享|领)").matcher(text).find())return null;
        Parsed r=new Parsed();r.paymentChannel=wechat?"wechat":alipay?"alipay":source.equals("com.unionpay")?"unionpay":sms?"sms":"unknown";
        r.knownSource=wechat||alipay||source.equals("com.unionpay");boolean bankSource=false;
        for(String[] bank:BANKS)if(source.equals(bank[3])||(sms&&(bankTitle.replaceFirst("^\\+?86","").equals(bank[4])||bankTitle.matches(bank[2])))){r.bankId=bank[0];r.bankName=bank[1];bankSource=true;r.knownSource=true;r.paymentChannel="bank";break;}
        BankNotice bankNotice=bankNotice(text,bankSource);
        String direction=text.replace("收款方","商户").replace("收款人","商户").replace("收款商家","商户");
        boolean income=has(direction,"收款","到账","入账","收入","转入"),expense=has(direction,"支付成功","付款成功","已支付","已付款","消费","扣款","支出","支取","付款金额","支付金额","实付","转出");
        r.transactionKind=has(text,"退款","退回","撤销","冲正")?"refund":has(text,"充值")?"recharge":has(text,"提现")?"withdrawal":has(text,"还款")?"repayment":has(text,"转账","转入","转出")?"transfer":income&&!expense?"income":expense?"payment":"unknown";
        r.type=income&&!expense?"income":"expense";
        r.completed=has(text,"支付成功","付款成功","已支付","已付款","扣款成功","交易成功","收款成功","收款到账","已收款","已到账","到账","已入账")||bankNotice.completed||(bankSource&&Pattern.compile("(?:消费|扣款|支出|支取|入账|收入)\\s*(?:人民币|RMB|CNY|[¥￥0-9]|金额|了|成功)").matcher(normalize(body)).find());
        List<Amount> amounts=new ArrayList<>();Matcher money=MONEY.matcher(text);while(money.find())amounts.add(amount(text,money.start(),money.group(1)!=null?money.group(1):money.group(2),null));
        Matcher fields=LABELED.matcher(text);while(fields.find())amounts.add(amount(text,fields.start(),fields.group(2),fields.group(1)));
        amounts.addAll(bankNotice.amounts);
        Set<Long> candidates=new LinkedHashSet<>(),best=new LinkedHashSet<>(),primary=new LinkedHashSet<>();int rank=0;boolean fee=false,invalid=false;String basis="unknown";
        for(Amount a:amounts){if(a.rank==-2)continue;if(a.value>0)candidates.add(a.value);if(a.rank>0&&a.value>=0)primary.add(a.value);if(a.fee&&a.value>0)fee=true;if(a.rank>rank){rank=a.rank;best.clear();invalid=false;basis=a.basis;}if(a.rank==rank&&rank>0){if(a.value<0)invalid=true;else best.add(a.value);}}
        if(rank==0||best.isEmpty()&&!invalid)return null;
        if(best.size()==1&&best.contains(0L)&&!invalid)return null;
        r.amountCandidates.addAll(candidates);boolean ambiguous=bankNotice.multiple||invalid||best.size()!=1||(rank<4&&(fee||primary.size()>1));
        if(!ambiguous){r.amount=best.iterator().next();r.amountBasis=basis;}
        readFunding(r,text,bankSource,bankNotice.tails);
        Set<String> references=new LinkedHashSet<>();Matcher ref=REF.matcher(text);while(ref.find())references.add(ref.group(1));if(references.size()==1)r.reference=references.iterator().next();
        Matcher merchant=MERCHANT.matcher(text);if(merchant.find())r.merchant=merchant.group(1).split("\\s+(?:付款方式|支付方式|订单号|交易单号|实付|付款金额|支付金额|支付时间)\\s*[:：]",2)[0].trim();
        if(r.merchant.isEmpty()){Matcher natural=Pattern.compile("(?:向|在)([^\\n，。；;:：]{2,35}?)(?:付款|支付|消费)(?:成功|人民币|[¥￥0-9]|\\s)").matcher(text);if(natural.find())r.merchant=natural.group(1).trim();}
        r.title=r.merchant.isEmpty()?(r.type.equals("income")?"通知收款":"通知付款"):clip(r.merchant,120);
        r.category=category(r.merchant+" "+text,r.type);
        r.snippet=clip(text.replaceAll("(?<![0-9])[0-9]{12,19}(?![0-9])","[号码已隐藏]"),360);
        if(truncated)r.reason="通知内容被截断，请核对完整交易";
        else if(references.size()>1)r.reason="通知包含多个订单，请逐笔核对，避免合并或重复记账";
        else if(bankNotice.multiple)r.reason="通知包含多组银行交易信息，请逐笔核对";
        else if(ambiguous)r.reason="通知包含多个金额或费用，无法确定实付金额";
        else if(Pattern.compile("(?:人民币|RMB|CNY|[¥￥])\\s*[-−－]\\s*[0-9]|[-−－]\\s*(?:人民币|RMB|CNY|[¥￥])\\s*[0-9]|[-−－]\\s*[0-9]+(?:\\.[0-9]+)?\\s*元").matcher(text).find()){r.amount=0;r.reason="通知使用负金额，请核对实际金额和收支方向";}
        else if(Pattern.compile("USD|US\\$|\\$|美元|日元|欧元|港币|港元|英镑|JPY|EUR|HKD",Pattern.CASE_INSENSITIVE).matcher(text).find()){r.amount=0;r.reason="通知可能是外币交易，请核对币种和金额";}
        else if(!r.knownSource)r.reason="通知来源尚未确认，请核对交易";
        else if(sms&&r.lastFour.isEmpty())r.reason="短信银行卡信息不完整，请核对交易";
        else if(!r.transactionKind.equals("payment")&&!r.transactionKind.equals("income"))r.reason="退款、转账、充值提现或还款需要确认，避免重复统计收支";
        else if(income&&expense)r.reason="通知的收支方向不明确";
        else if(!r.completed)r.reason="请确认交易已经完成及收支方向";
        else if(r.ambiguousFunding)r.reason="通知出现多个付款账户，请核对资金来源";
        else r.confident=true;
        return r;
    }
    private static void readFunding(Parsed r,String text,boolean bankSource,Set<String> structuredTails){
        Set<String> tails=new LinkedHashSet<>(structuredTails);Matcher tail=TAIL.matcher(text);while(tail.find()){String prefix=text.substring(Math.max(0,tail.start()-8),tail.start());if(!prefix.matches(".*(?:订单|交易单|手机|电话)$"))tails.add(tail.group(1)!=null?tail.group(1):tail.group(2));}
        Matcher method=METHOD.matcher(text);List<String> methods=new ArrayList<>();while(method.find())methods.add(method.group(1).trim());
        String funding=String.join(" ",methods);r.fundingLabel=clip(funding,80);
        String bankScope=funding;
        if(bankSource||!tails.isEmpty()||Pattern.compile("(?:银行|工行|建行|农行|招行|中行|交行|邮储)\\s*[(][0-9]{4}[)]").matcher(text).find())bankScope+=" "+text;
        Set<String> bankIds=new LinkedHashSet<>();String foundBank="",foundName="";for(String[] bank:BANKS)if(Pattern.compile(bank[2]).matcher(bankScope).find()){bankIds.add(bank[0]);foundBank=bank[0];foundName=bank[1];}
        boolean wallet=has(funding,"零钱","余额","余额宝","零钱通")||Pattern.compile("(?:使用|通过|从)(?:微信)?(?:零钱通|零钱|余额宝|余额)(?:支付|付款|扣款)").matcher(text).find();
        boolean credit=has(funding,"花呗","白条","信用支付");
        boolean card=bankSource||!tails.isEmpty()||!bankIds.isEmpty()||has(funding,"银行卡","储蓄卡","信用卡");
        if(!bankIds.isEmpty()){if(bankSource&&!r.bankId.equals(foundBank))r.ambiguousFunding=true;r.bankId=foundBank;r.bankName=foundName;}
        if(card){Matcher bracket=Pattern.compile("(?:银行|银行卡|储蓄卡|信用卡|卡|工行|建行|农行|招行|中行|交行|邮储)\\s*[(]([0-9]{4})[)]").matcher(text);while(bracket.find())tails.add(bracket.group(1));}
        if(tails.size()==1)r.lastFour=tails.iterator().next();
        r.ambiguousFunding|=tails.size()>1||bankIds.size()>1||(wallet&&card)||(credit&&(wallet||card));
        r.fundingSource=credit?"credit":card?"bank":wallet?"wallet":"unknown";
        if(bankSource){if(has(text,"微信支付","财付通"))r.paymentChannel="wechat";else if(has(text,"支付宝"))r.paymentChannel="alipay";}
    }
    private static String category(String text,String type){
        if(type.equals("income"))return has(text,"工资","薪资")?"工资薪资":"其他收入";
        if(has(text,"咖啡","奶茶","餐","饭","外卖","美团","饿了么"))return "餐饮美食";
        if(has(text,"地铁","公交","打车","滴滴","高铁","火车","停车","加油"))return "交通出行";
        if(has(text,"超市","便利店","淘宝","京东","拼多多","购物","菜市场","生鲜"))return "购物消费";
        if(has(text,"会员","订阅","ChatGPT","Claude","Gemini"))return "会员订阅";
        if(has(text,"话费","水费","电费","燃气","宽带"))return "居住生活";
        return "其他支出";
    }
}
