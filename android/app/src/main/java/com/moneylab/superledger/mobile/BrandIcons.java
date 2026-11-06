package com.moneylab.superledger.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.Locale;

/** Brand assets are copies / lossless format adaptations of the desktop's existing official logos. */
public final class BrandIcons {
    private BrandIcons() {}
    public static final String[][] BANKS = {
        {"icbc", "工商银行", "#c83338"}, {"ccb", "建设银行", "#2b68ab"}, {"abc", "农业银行", "#258879"},
        {"cmb", "招商银行", "#c73142"}, {"boc", "中国银行", "#a83249"}, {"bocom", "交通银行", "#345598"},
        {"psbc", "邮储银行", "#287b63"}, {"pingan", "平安银行", "#e98b3e"}
    };
    public static final String[][] SERVICES = {
        {"chatgpt", "ChatGPT", "#171717", "Go|Plus|Pro 100|Pro 200|Pro 500"},
        {"claude", "Claude", "#D97757", "Pro|Max|Ultra"},
        {"gemini", "Gemini", "#4285F4", "Google AI Plus|Google AI Pro|Google AI Ultra 5x|Google AI Ultra 20x"},
        {"ttvoice", "TT语音", "#5E69F5", "超级玩家|超级玩家SVIP"},
        {"kugou", "酷狗音乐", "#009DF4", "豪华VIP|超级VIP|音乐包"},
        {"baidu", "百度网盘", "#2F7DF4", "会员|超级会员"},
        {"netease", "网易云音乐", "#E6343B", "黑胶VIP|黑胶SVIP|音乐包"},
        {"bilibili", "哔哩哔哩", "#FB7299", "大会员"},
        {"icloud", "iCloud+", "#479FF8", "50GB|200GB|2TB|6TB|12TB"}
    };
    public static final String[][] ACCOUNTS = {
        {"wechat", "微信", "数字钱包", "#28b877"}, {"alipay", "支付宝", "数字钱包", "#3e9ee8"},
        {"bank-card", "银行卡", "银行卡", "#849fda"}, {"cash", "现金", "现金", "#c8a66c"}, {"virtual-card", "虚拟卡", "虚拟卡", "#a28ad6"}
    };
    public static String forAccount(JSONObject account) {
        if (account == null) return "";
        if (!account.optString("bankId").isEmpty()) return account.optString("bankId");
        if (!account.optString("providerId").isEmpty()) return account.optString("providerId");
        String name = account.optString("name"); if (name.contains("微信")) return "wechat"; if (name.contains("支付宝")) return "alipay";
        for (String[] bank : BANKS) if (name.contains(bank[1])) return bank[0]; return "";
    }
    public static String forSubscription(JSONObject subscription) {
        if (!subscription.optString("serviceId").isEmpty()) return subscription.optString("serviceId");
        String name = subscription.optString("name").toLowerCase(Locale.ROOT);
        for (String[] service : SERVICES) if (name.contains(service[1].toLowerCase(Locale.ROOT))) return service[0];
        if (name.contains("网易云")) return "netease"; if (name.contains("b站")) return "bilibili"; if (name.contains("百度云")) return "baidu"; return "";
    }
    public static String forSource(String packageName) {
        if (packageName.equals("com.tencent.mm")) return "wechat"; if (packageName.equals("com.eg.android.AlipayGphone")) return "alipay";
        if (packageName.equals("com.icbc")) return "icbc"; if (packageName.equals("com.chinamworld.main")) return "ccb";
        if (packageName.equals("com.android.bankabc")) return "abc"; if (packageName.equals("cmb.pb")) return "cmb";
        if (packageName.equals("com.chinamworld.bocmbci")) return "boc"; if (packageName.equals("com.bankcomm.Bankcomm")) return "bocom";
        if (packageName.equals("com.yitong.mbank.psbc")) return "psbc"; if (packageName.equals("com.pingan.paces.ccms")) return "pingan"; return "";
    }
    public static int resource(String id) {
        switch (id) {
            case "wechat": return R.drawable.logo_wechat; case "alipay": return R.drawable.logo_alipay;
            case "chatgpt": return R.drawable.logo_chatgpt; case "claude": return R.drawable.logo_claude;
            case "gemini": return R.drawable.logo_gemini; case "ttvoice": return R.drawable.logo_ttvoice;
            case "kugou": return R.drawable.logo_kugou; case "baidu": return R.drawable.logo_baidu;
            case "netease": return R.drawable.logo_netease; case "bilibili": return R.drawable.logo_bilibili; case "icloud": return R.drawable.logo_icloud;
            case "icbc": return R.drawable.logo_icbc; case "ccb": return R.drawable.logo_ccb; case "abc": return R.drawable.logo_abc; case "cmb": return R.drawable.logo_cmb;
            case "boc": return R.drawable.logo_boc; case "bocom": return R.drawable.logo_bocom; case "psbc": return R.drawable.logo_psbc; case "pingan": return R.drawable.logo_pingan;
            default: return 0;
        }
    }
    public static View view(Context context, String brandId, String fallback, int color, int size) {
        float density = context.getResources().getDisplayMetrics().density; int resource = resource(brandId);
        GradientDrawable background = new GradientDrawable(); background.setColor(brandId.equals("ttvoice") ? 0xFF5E69F5 : resource == 0 ? color : Color.WHITE); background.setCornerRadius(13 * density);
        if (resource != 0) { background.setStroke(Math.max(1, (int) density), 0xFFECECF2); ImageView image = new ImageView(context); image.setImageResource(resource); image.setScaleType(ImageView.ScaleType.FIT_CENTER); int pad = (int) (size * .16f * density); image.setPadding(pad, pad, pad, pad); image.setBackground(background); image.setContentDescription(fallback); return image; }
        TextView label = new TextView(context); label.setText(fallback == null || fallback.isEmpty() ? "账" : fallback.substring(0, 1)); label.setTextSize(size * .38f); label.setTextColor(Color.WHITE); label.setTypeface(Typeface.DEFAULT_BOLD); label.setGravity(Gravity.CENTER); label.setBackground(background); return label;
    }
}
