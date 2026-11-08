package com.moneylab.superledger.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.Arrays;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.io.OutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity implements AppUpdater.Listener {
    public static final String ACTION_CHANGED = "com.moneylab.superledger.mobile.CHANGED";
    private static final int BG = MobileStyle.BG, INK = MobileStyle.INK, MUTED = MobileStyle.MUTED, PURPLE = MobileStyle.ACCENT, LINE = MobileStyle.LINE, GREEN = MobileStyle.GREEN, RED = 0xFFBF5264, SOFT = MobileStyle.SOFT;
    private LedgerStore store;
    private LinearLayout root, body;
    private int page, visibleTransactions = 100;
    private boolean receiverRegistered, destroyed;
    private boolean subscriptionChart;
    private SyncClient.Pairing pairing;
    private String syncMessage = "", lastError = "";
    private boolean recoveryAfterExport;
    private AppUpdater updater;
    private boolean resumed, temporaryActivity;
    private final Handler recurringHandler = new Handler(Looper.getMainLooper());
    private final Runnable recurringTick = () -> { if (resumed && !destroyed) { render(); scheduleRecurring(); } };
    private MobileUpdateDialog mobileUpdates;
    private LinearLayout updatePanel;
    private TextView updateProgressLabel;
    private ProgressBar updateProgressBar;
    private String updateCardKey = "";
    private String selectedMonth = LedgerStore.today().substring(0, 7), selectedAccount = "", selectedCategory = "", selectedType = "", searchQuery = "", moreSection = "", recurringError = "";
    private final BroadcastReceiver receiver = new BroadcastReceiver() { @Override public void onReceive(Context context, Intent intent) { render(); scheduleRecurring(); } };
    private interface Action { void run() throws Exception; }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        subscriptionChart=getPreferences(MODE_PRIVATE).getBoolean("subscriptionChart",false);
        if (saved != null) { page = saved.getInt("page", 0); selectedMonth = saved.getString("month", selectedMonth); selectedAccount = saved.getString("account", ""); selectedCategory = saved.getString("category", ""); selectedType = saved.getString("type", ""); searchQuery = saved.getString("query", ""); moreSection = saved.getString("section", ""); temporaryActivity = saved.getBoolean("temporaryActivity", false); }
        try { store = LedgerStore.get(this); } catch (Exception e) { showFatal(e); return; }
        updater = AppUpdater.get(this);
        mobileUpdates = new MobileUpdateDialog(this, updater, new MobileUpdateDialog.Host() {
            @Override public boolean canInstall() { return store != null && !store.isSyncing(); }
            @Override public void onDismiss() { if (!destroyed && root != null) root.post(MainActivity.this::maybeShowUpdateUi); }
        });
        IntentFilter filter = new IntentFilter(ACTION_CHANGED);filter.addAction(Intent.ACTION_TIME_CHANGED);filter.addAction(Intent.ACTION_TIMEZONE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED); else registerReceiver(receiver, filter);
        receiverRegistered = true; render();
    }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); out.putInt("page", page); out.putString("month", selectedMonth); out.putString("account", selectedAccount); out.putString("category", selectedCategory); out.putString("type", selectedType); out.putString("query", searchQuery); out.putString("section", moreSection); out.putBoolean("temporaryActivity", temporaryActivity); }
    @Override public void onBackPressed() { if (page == 3 && !moreSection.isEmpty()) { moreSection = ""; render(); } else super.onBackPressed(); }
    @Override protected void onStart() { super.onStart(); if (updater != null) updater.onActivityStarted(); }
    @Override protected void onStop() { if (updater != null) updater.onActivityStopped(isChangingConfigurations() || temporaryActivity); temporaryActivity = false; super.onStop(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (updater != null && Intent.ACTION_MAIN.equals(intent.getAction()) && intent.hasCategory(Intent.CATEGORY_LAUNCHER)) updater.onLauncherIntent(); }
    @Override public void startActivityForResult(Intent intent, int requestCode, Bundle options) { temporaryActivity = true; try { super.startActivityForResult(intent, requestCode, options); } catch (RuntimeException error) { temporaryActivity = false; throw error; } }
    @Override protected void onResume() { super.onResume(); resumed = true; temporaryActivity = false; if (store != null) render(); scheduleRecurring(); if (updater != null) updater.attach(this); }
    @Override protected void onPause() { resumed = false; recurringHandler.removeCallbacks(recurringTick); if (updater != null) updater.detach(this); super.onPause(); }
    private void scheduleRecurring() {
        recurringHandler.removeCallbacks(recurringTick);
        if (resumed && !destroyed) recurringHandler.postDelayed(recurringTick, 3_600_000L - Math.floorMod(System.currentTimeMillis(), 3_600_000L) + 25);
    }
    @Override protected void onDestroy() { destroyed = true; if (mobileUpdates != null) mobileUpdates.dispose(); if (updater != null) updater.detach(this); if (receiverRegistered) unregisterReceiver(receiver); super.onDestroy(); }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (focused) maybeShowUpdateUi(); }
    @Override public void onUpdaterChanged() {
        if (destroyed || !resumed) return;
        if (mobileUpdates != null) mobileUpdates.refresh();
        if (page == 4 && updatePanel != null && updatePanel.isAttachedToWindow()) refreshUpdateCard(updater.snapshot());
        maybeShowUpdateUi();
    }
    private void maybeShowUpdateUi() {
        if (destroyed || !resumed || updater == null || mobileUpdates == null || store == null || store.isSyncing()) return;
        // Our own update dialog owns focus while open. Other dialogs (including
        // an unfinished ledger form) must finish before an automatic offer.
        if (!hasWindowFocus() && !mobileUpdates.isShowing()) return;
        Intent confirmation = updater.consumeConfirmation();
        if (confirmation != null) {
            mobileUpdates.dismiss();
            try { startActivityForResult(confirmation, AppUpdater.INSTALL_CONFIRM_REQUEST); }
            catch (Exception error) { updater.installerReturned(); error("无法打开系统安装确认界面，请在设置中重新点「安装更新」。"); }
            return;
        }
        if (updater.consumeInstallRequest()) { mobileUpdates.showReady(); return; }
        UpdatePolicy.Release release = updater.consumeOffer(); if (release != null) mobileUpdates.showOffer(release);
    }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void act(Action action) { try { action.run(); } catch (Exception e) { error(e.getMessage()); } }
    private AlertDialog.Builder dialogBuilder() {
        return new AlertDialog.Builder(this) {
            @Override public AlertDialog show() { AlertDialog dialog = super.show(); MobileStyle.styleDialog(dialog); return dialog; }
        };
    }
    private void error(String message) { dialogBuilder().setTitle("暂时无法完成").setMessage(message == null ? "请稍后重试，已有记录仍保留。" : message).setPositiveButton("知道了", null).show(); }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_SHORT).show(); }
    private GradientDrawable rounded(int color, int radius) { return MobileStyle.surface(this, color, radius); }
    private boolean largeText() { return getResources().getConfiguration().fontScale > 1.15f; }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setTypeface(Typeface.create(bold ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
        view.setLineSpacing(dp(3), 1); if (bold && size >= 22) view.setLetterSpacing(-.025f);
        view.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_SIMPLE); return view;
    }
    private TextView label(String value) { TextView v = text(value, 13, MUTED, false); v.setPadding(0, dp(5), 0, dp(7)); return v; }
    private LinearLayout column() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    private LinearLayout row() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.HORIZONTAL); layout.setGravity(Gravity.CENTER_VERTICAL); return layout; }
    private void gap(LinearLayout parent, int height) { parent.addView(new View(this), new LinearLayout.LayoutParams(1, dp(height))); }
    private void divider(LinearLayout parent) { View view = new View(this); view.setBackgroundColor(LINE); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.topMargin = dp(14); params.bottomMargin = dp(14); parent.addView(view, params); }
    private LinearLayout card() {
        LinearLayout card = column(); card.setBackground(MobileStyle.material(this, 0xFF9AAAC4, 22));
        MobileStyle.softElevation(card, 2);
        card.setPadding(dp(19), dp(20), dp(19), dp(20)); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(16); body.addView(card, params); return card;
    }
    private Button button(String value, boolean primary, Action action) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false); button.setTextSize(14);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setTextColor(primary ? Color.WHITE : PURPLE);
        button.setBackground(MobileStyle.buttonBackground(this, primary)); button.setPadding(dp(13), dp(12), dp(13), dp(12));
        button.setMinHeight(dp(48)); button.setMinimumHeight(dp(48)); button.setMinWidth(0); button.setMinimumWidth(0);
        button.setStateListAnimator(null); MobileStyle.softElevation(button, primary ? 2 : 0);
        button.setOnClickListener(v -> act(action)); return button;
    }
    private void addButton(LinearLayout parent, String value, boolean primary, Action action) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(10); parent.addView(button(value, primary, action), params); }
    private View icon(String name, int color, int size) { return MobileIcons.view(this, name, color, size); }
    private void sectionTitle(LinearLayout parent, String name, String glyph) {
        LinearLayout line = row(); FrameLayout mark = new FrameLayout(this); mark.setBackground(MobileStyle.material(this, PURPLE, 10));
        FrameLayout.LayoutParams centered = new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER); mark.addView(icon(glyph, PURPLE, 18), centered);
        LinearLayout.LayoutParams stamp = new LinearLayout.LayoutParams(dp(32), dp(32)); stamp.rightMargin = dp(10); line.addView(mark, stamp);
        line.addView(text(name, 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); parent.addView(line); gap(parent, 9);
    }
    private TextView link(String value, Action action) {
        TextView view = text(value, 12, PURPLE, true); view.setGravity(Gravity.CENTER); view.setPadding(dp(10), dp(10), dp(4), dp(10));
        view.setMinHeight(dp(48)); view.setBackground(MobileStyle.ripple(this, Color.TRANSPARENT, 10)); view.setOnClickListener(v -> act(action)); view.setFocusable(true); return view;
    }
    private TextView amountText(String value, int size, int color) {
        TextView amount = text(value, size, color, true); amount.setFontFeatureSettings("tnum");
        if (!largeText() && value.length() <= 14) { amount.setMaxLines(1); amount.setAutoSizeTextTypeUniformWithConfiguration(12, size, 1, android.util.TypedValue.COMPLEX_UNIT_SP); }
        return amount;
    }
    private void showFatal(Exception error) { LinearLayout panel = column(); panel.setPadding(dp(24), dp(60), dp(24), dp(24)); panel.addView(text("手机账本暂时无法读取", 24, INK, true)); panel.addView(label("原文件已保留，应用不会自动创建空账本覆盖你的数据。\n" + error.getMessage())); setContentView(panel); }
    private void render() {
        if (destroyed || store == null) return;
        try {
            if (!store.isSyncing()) { try { store.applyRecurring(); recurringError = ""; } catch (Exception error) { recurringError = error.getMessage() == null ? "请核对订阅和账户设置" : error.getMessage(); } }
            JSONObject data = store.snapshot(); updatePanel = null; updateProgressLabel = null; updateProgressBar = null; updateCardKey = ""; root = column(); root.setBackgroundColor(BG);
            root.setOnApplyWindowInsetsListener((v, insets) -> { v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
            LinearLayout header = row(); header.setPadding(dp(20), dp(14), dp(20), dp(14)); header.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{Color.WHITE, BG}));
            FrameLayout brand = new FrameLayout(this); brand.setBackground(MobileStyle.buttonBackground(this, true)); MobileStyle.softElevation(brand, 2); brand.addView(icon("ledger", Color.WHITE, 25), new FrameLayout.LayoutParams(dp(25), dp(25), Gravity.CENTER)); header.addView(brand, new LinearLayout.LayoutParams(dp(42), dp(42)));
            LinearLayout titles = column(); titles.setPadding(dp(11), 0, dp(6), 0); titles.addView(text("超级账本", 19, INK, true)); titles.addView(text("MONEY LAB · 随身记", 9, MUTED, false)); header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
            LinearLayout badge = row(); badge.setPadding(dp(10), dp(8), dp(10), dp(8)); badge.setBackground(MobileStyle.ripple(this, SOFT, 14)); badge.setMinimumHeight(dp(48)); badge.addView(icon("sync", PURPLE, 17));
            TextView syncLabel = text(store.isSyncing() ? "同步中" : "扫码同步", 11, PURPLE, true); syncLabel.setPadding(dp(5), 0, 0, 0); badge.addView(syncLabel); badge.setContentDescription(store.isSyncing() ? "查看同步状态" : "扫码同步到电脑"); badge.setFocusable(true); badge.setOnClickListener(v -> openMore("sync")); header.addView(badge); root.addView(header);
            ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false); body = column(); body.setClipChildren(false); body.setClipToPadding(false); body.setPadding(dp(20), dp(8), dp(20), dp(24)); scroll.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
            if (!recurringError.isEmpty()) { LinearLayout alert = card(); alert.addView(text("订阅记账需要检查", 15, RED, true)); alert.addView(label(recurringError)); }
            try {
                if (page == 0) renderOverview(data); else if (page == 1) renderTransactions(data); else if (page == 2) renderAccounts(data); else if (page == 3) renderMore(data); else renderSettings(data);
            } catch (Exception displayError) {
                body.removeAllViews(); LinearLayout recovery = card(); recovery.addView(text("这页暂时无法计算", 21, RED, true));
                recovery.addView(label("手机数据仍然保留。同步冲突可能使合并预览暂时超出金额范围，请先处理冲突或导出备份。\n" + (displayError.getMessage() == null ? "请核对账本数据" : displayError.getMessage())));
                addButton(recovery, "查看待确认与同步冲突", true, () -> openMore("review")); addButton(recovery, "导出手机完整备份", false, () -> exportBackup(false));
            }
            View navLine = new View(this); navLine.setBackgroundColor(LINE); root.addView(navLine, new LinearLayout.LayoutParams(-1, dp(1)));
            LinearLayout tabs = row(); tabs.setPadding(dp(10), dp(8), dp(10), dp(8)); tabs.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{Color.WHITE, 0xFFFBFCFF})); MobileStyle.softElevation(tabs, 4);
            int review = data.getJSONArray("pending").length() + data.getJSONArray("conflicts").length();
            String[] names = {"总览", "账单", "资产", "更多", "设置"}, glyphs = {"home", "list", "wallet", "grid", "settings"};
            for (int i = 0; i < names.length; i++) {
                final int target = i; boolean active = page == i; LinearLayout tab = column(); tab.setGravity(Gravity.CENTER); tab.setPadding(dp(2), dp(5), dp(2), dp(5)); tab.setMinimumHeight(dp(58)); tab.setBackground(MobileStyle.ripple(this, Color.TRANSPARENT, 14));
                FrameLayout symbol = new FrameLayout(this); if (active) symbol.setBackground(MobileStyle.material(this, PURPLE, 11)); symbol.addView(icon(glyphs[i], active ? PURPLE : MUTED, 21), new FrameLayout.LayoutParams(dp(21), dp(21), Gravity.CENTER));
                if (i == 3 && review > 0) { View dot = new View(this); dot.setBackground(rounded(RED, 5)); FrameLayout.LayoutParams dotParams = new FrameLayout.LayoutParams(dp(6), dp(6), Gravity.TOP | Gravity.END); symbol.addView(dot, dotParams); }
                tab.addView(symbol, new LinearLayout.LayoutParams(dp(42), dp(31))); TextView caption = text(names[i], 11, active ? PURPLE : MUTED, active); caption.setGravity(Gravity.CENTER); caption.setPadding(0, dp(3), 0, 0); tab.addView(caption);
                tab.setContentDescription(names[i] + (i == 3 && review > 0 ? "，" + review + " 项待确认" : "") + (active ? "，已选中" : "")); tab.setSelected(active); tab.setFocusable(true); tab.setOnClickListener(v -> { page = target; render(); });
                LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, -2, 1); p.leftMargin = dp(2); p.rightMargin = dp(2); tabs.addView(tab, p);
            }
            root.addView(tabs); setContentView(root); root.requestApplyInsets(); root.post(this::maybeShowUpdateUi);
        } catch (Exception e) { showFatal(e); }
    }
    private static JSONObject findAccount(JSONObject state, String id) throws Exception { JSONArray accounts = state.getJSONArray("accounts"); for (int i = 0; i < accounts.length(); i++) if (id.equals(accounts.getJSONObject(i).optString("id"))) return accounts.getJSONObject(i); return null; }
    private static String accountName(JSONObject account) { if (account == null) return "未选账户"; if (AppleBalance.isAppleBalance(account)) return AppleBalance.accountLabel(account); String currency = account.optString("currency", "CNY"); return account.optString("name", "账户") + (account.optString("lastFour").isEmpty() ? "" : " · " + account.optString("lastFour")) + (currency.equals("CNY") ? "" : " · " + currency); }
    private static String money(long amount, String currency) { try { return MobileLedger.formatMoney(amount, currency); } catch (Exception e) { return "金额待核对"; } }
    private static String amountInput(long amount, String currency) { try { return MobileLedger.amountInput(amount, currency); } catch (Exception e) { return ""; } }
    private static String when(long millis) { return millis <= 0 ? "尚未同步" : MobileLedger.beijingDateTime(millis).format(DateTimeFormatter.ofPattern("MM-dd HH:mm",Locale.CHINA)); }
    private static JSONArray items(JSONObject state, String key) { JSONArray value = state.optJSONArray(key); return value == null ? new JSONArray() : value; }
    private static int safeColor(String color) { try { return Color.parseColor(color); } catch (Exception error) { return PURPLE; } }
    private void openMore(String section) { page = 3; moreSection = section; render(); }
    private void heading(String title, String subtitle) { TextView eyebrow = text("我的财务空间", 11, MUTED, false); eyebrow.setPadding(0, dp(6), 0, dp(8)); body.addView(eyebrow); body.addView(text(title, 25, INK, true)); if (!subtitle.isEmpty()) body.addView(label(subtitle)); gap(body, 14); }
    private void addLogo(LinearLayout parent, String id, String label, String color, int size) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(size), dp(size)); p.rightMargin = dp(12); parent.addView(BrandIcons.view(this, id, label, safeColor(color), size), p); }
    private void actionPair(LinearLayout parent, String left, Action first, String right, Action second) {
        LinearLayout actions = largeText() ? column() : row();
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(largeText() ? -1 : 0, -2, largeText() ? 0 : 1), b = new LinearLayout.LayoutParams(largeText() ? -1 : 0, -2, largeText() ? 0 : 1);
        if (largeText()) b.topMargin = dp(8); else { a.rightMargin = dp(5); b.leftMargin = dp(5); }
        actions.addView(button(left, false, first), a); actions.addView(button(right, false, second), b); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(10); parent.addView(actions, p);
    }
    private void metric(LinearLayout parent, String title, long value, int color) {
        boolean stacked = parent.getOrientation() == LinearLayout.VERTICAL;
        LinearLayout part = column(); part.setPadding(0, 0, stacked ? 0 : dp(5), 0); part.addView(text(title, 11, MUTED, false)); gap(part, 5); part.addView(amountText(money(value, "CNY"), 18, color));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(stacked ? -1 : 0, -2, stacked ? 0 : 1); if (stacked && parent.getChildCount() > 0) params.topMargin = dp(12); parent.addView(part, params);
    }
    private void metrics(LinearLayout parent, JSONObject summary) {
        boolean stacked = largeText(); float available = dp(Math.max(1, (getResources().getConfiguration().screenWidthDp - 88) / 3));
        TextView measure = text("", 14, INK, true);
        for (String key : new String[]{"income", "expense", "balance"}) if (measure.getPaint().measureText(money(summary.optLong(key), "CNY")) > available) stacked = true;
        LinearLayout values = stacked ? column() : row(); metric(values, "收入", summary.optLong("income"), GREEN); metric(values, "支出", summary.optLong("expense"), INK); metric(values, "结余", summary.optLong("balance"), PURPLE); parent.addView(values);
    }
    private void progress(LinearLayout parent, long value, long maximum, int color) { ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); bar.setMax(1000); bar.setProgress(maximum <= 0 ? 0 : (int)Math.min(1000, Math.max(0, (double)value / maximum * 1000))); bar.setProgressTintList(android.content.res.ColorStateList.valueOf(color)); bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(LINE)); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, dp(8)); p.topMargin = dp(8); p.bottomMargin = dp(5); parent.addView(bar, p); }
    private void renderOverview(JSONObject data) throws Exception {
        JSONObject state = data.getJSONObject("state"); String today = LedgerStore.today(), month = today.substring(0, 7); JSONArray accounts = items(state, "accounts");
        JSONObject monthly = MobileLedger.monthlySummary(state, month, today), daily = MobileLedger.dailySummary(state, today);
        LinearLayout welcome = row(); welcome.setPadding(0, dp(4), 0, dp(18)); LinearLayout greeting = column();
        greeting.addView(text(MobileLedger.beijingDateTime(System.currentTimeMillis()).format(DateTimeFormatter.ofPattern("M 月 d 日 · E",Locale.CHINA)), 11, MUTED, false)); gap(greeting, 7);
        greeting.addView(text("每一笔，\n都心中有数。", 25, INK, true)); gap(greeting, 4); greeting.addView(text("好好生活，慢慢积累。", 12, MUTED, false)); welcome.addView(greeting, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView artwork = new ImageView(this); artwork.setImageResource(R.drawable.ledger_bloom); artwork.setScaleType(ImageView.ScaleType.FIT_CENTER); artwork.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); welcome.addView(artwork, new LinearLayout.LayoutParams(dp(108), dp(118))); body.addView(welcome);
        LinearLayout hero = card(); hero.setBackground(MobileStyle.heroSurface(this));
        LinearLayout assetTitle = row(); assetTitle.addView(icon("wallet", PURPLE, 17)); TextView assetLabel = text("当前净资产 · 折合人民币", 12, MUTED, false); assetLabel.setPadding(dp(7), 0, 0, 0); assetTitle.addView(assetLabel, new LinearLayout.LayoutParams(0, -2, 1)); hero.addView(assetTitle); gap(hero, 14);
        hero.addView(amountText(money(MobileLedger.netWorth(state, today), "CNY"), 36, INK));
        LinearLayout caption = row(); caption.addView(text(accounts.length() + " 个账户的当前余额", 11, MUTED, false), new LinearLayout.LayoutParams(0, -2, 1)); caption.addView(link("管理账户 ›", () -> { page = 2; render(); })); hero.addView(caption);
        divider(hero); TextView monthCaption = text("本月收支 · " + month, 11, MUTED, false); hero.addView(monthCaption); gap(hero, 10); metrics(hero, monthly);
        LinearLayout record = card(); sectionTitle(record, accounts.length() == 0 ? "开始你的账本" : "今日记录", "plus");
        if (accounts.length() == 0) {
            record.addView(text("从第一个账户开始。", 20, INK, true)); record.addView(label("添加钱包或银行卡，填入真实余额。也可以扫码合并电脑账本。")); addButton(record, "添加第一个账户", true, () -> editAccount(null)); addButton(record, "连接电脑账本", false, () -> openMore("sync"));
        } else {
            record.addView(text("随手记，轻松一点。", 20, INK, true)); gap(record, 12); metrics(record, daily);
            addButton(record, "＋ 记一笔支出", true, () -> newTransaction("expense", "")); actionPair(record, "记收入", () -> newTransaction("income", ""), "账户转账", () -> newTransaction("transfer", ""));
        }
        int review = items(data, "pending").length() + items(data, "conflicts").length(); LinearLayout sync = card();
        sectionTitle(sync, review > 0 ? review + " 项需要确认" : "账本已保存在手机", review > 0 ? "check" : "shield"); sync.addView(label("待同步 " + items(data, "operations").length() + " 项 · 上次同步 " + when(data.optLong("lastSyncAt"))));
        actionPair(sync, review > 0 ? "查看待确认" : "自动记账设置", () -> { if (review > 0) openMore("review"); else { page = 4; render(); } }, "扫码同步", () -> openMore("sync"));
        LinearLayout recent = card(), recentHeading = row(); recentHeading.addView(text("最近账单", 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        recentHeading.addView(link("全部账单 ›", () -> { selectedMonth = ""; selectedAccount = ""; selectedCategory = ""; selectedType = ""; searchQuery = ""; page = 1; render(); })); recent.addView(recentHeading);
        List<JSONObject> txs = sortedTransactions(state);
        if (txs.isEmpty()) { gap(recent, 8); recent.addView(text("故事，等你写下第一笔。", 15, INK, true)); recent.addView(label("从今天开始，让钱的来去清清楚楚。")); }
        for (int i = 0; i < Math.min(5, txs.size()); i++) { if (i > 0) divider(recent); final JSONObject tx = txs.get(i); addTransactionRow(recent, tx, state); recent.getChildAt(recent.getChildCount() - 1).setOnClickListener(v -> act(() -> editTransaction(tx, null))); }
        long budget = monthly.optLong("budget"); LinearLayout budgetCard = card(); budgetCard.setBackground(MobileStyle.material(this, PURPLE, 22)); LinearLayout budgetHeading = row();
        budgetHeading.addView(text("本月预算", 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); budgetHeading.addView(link(budget > 0 ? "调整 ›" : "设置 ›", this::editBudget)); budgetCard.addView(budgetHeading);
        if (budget > 0) { progress(budgetCard, monthly.optLong("expense"), budget, monthly.optLong("remaining") < 0 ? RED : PURPLE); budgetCard.addView(label((monthly.optLong("remaining") >= 0 ? "还可使用 " : "已超出 ") + money(Math.abs(monthly.optLong("remaining")), "CNY") + " / 预算 " + money(budget, "CNY"))); }
        else budgetCard.addView(label("为日常花销，留一点计划。"));
    }
    private List<JSONObject> sortedTransactions(JSONObject state) throws Exception { List<JSONObject> list=new ArrayList<>();JSONArray array=items(state,"transactions");for(int i=0;i<array.length();i++)list.add(array.getJSONObject(i));Collections.sort(list,(a,b)->b.optString("date").compareTo(a.optString("date")));return list; }
    private List<JSONObject> filteredTransactions(JSONObject state) throws Exception {
        List<JSONObject> result=new ArrayList<>();String search=searchQuery.toLowerCase(Locale.ROOT).trim();
        for(JSONObject tx:sortedTransactions(state)){if(!selectedMonth.isEmpty()&&!tx.optString("date").startsWith(selectedMonth))continue;if(!selectedType.isEmpty()&&!selectedType.equals(tx.optString("type")))continue;if(!selectedCategory.isEmpty()&&!selectedCategory.equals(tx.optString("category")))continue;if(!selectedAccount.isEmpty()&&!selectedAccount.equals(tx.optString("accountId"))&&!selectedAccount.equals(tx.optString("toAccountId")))continue;
            if(!search.isEmpty()){String haystack=(tx.optString("title")+" "+tx.optString("note")+" "+tx.optString("category")+" "+accountName(findAccount(state,tx.optString("accountId")))+" "+amountInput(tx.optLong("amount"),tx.optString("currency","CNY"))).toLowerCase(Locale.ROOT);if(!haystack.contains(search))continue;}result.add(tx);}return result;
    }
    private void renderTransactions(JSONObject data) throws Exception {
        JSONObject state=data.getJSONObject("state");heading("每一笔，都有去处","搜索、筛选和导出手机与电脑的全部账单。");
        LinearLayout filters=card();LinearLayout months=row();months.addView(button("‹",false,()->shiftMonth(-1)),new LinearLayout.LayoutParams(dp(48),-2));Button current=button(selectedMonth.isEmpty()?"全部月份":selectedMonth+"  ▾",false,this::chooseMonth);LinearLayout.LayoutParams middle=new LinearLayout.LayoutParams(0,-2,1);middle.leftMargin=dp(6);middle.rightMargin=dp(6);months.addView(current,middle);months.addView(button("›",false,()->shiftMonth(1)),new LinearLayout.LayoutParams(dp(48),-2));filters.addView(months);
        EditText query=new EditText(this);styleInput(query);query.setSingleLine(true);query.setHint("搜索商家、备注、账户或金额");query.setText(searchQuery);LinearLayout.LayoutParams queryParams=new LinearLayout.LayoutParams(-1,-2);queryParams.topMargin=dp(12);queryParams.bottomMargin=dp(10);filters.addView(query,queryParams);
        boolean verticalFilters=largeText();LinearLayout first=verticalFilters?column():row();List<String> typeNames=Arrays.asList("全部收支","支出","收入","账户转账");String[] typeValues={"","expense","income","transfer"};Spinner types=spinner(typeNames);types.setSelection(Math.max(0,Arrays.asList(typeValues).indexOf(selectedType)));first.addView(types,new LinearLayout.LayoutParams(verticalFilters?-1:0,-2,verticalFilters?0:1));
        List<String> accountNames=new ArrayList<>(),accountIds=new ArrayList<>();accountNames.add("全部账户");accountIds.add("");JSONArray accounts=items(state,"accounts");for(int i=0;i<accounts.length();i++){JSONObject a=accounts.getJSONObject(i);accountNames.add(accountName(a));accountIds.add(a.getString("id"));}Spinner account=spinner(accountNames);account.setSelection(Math.max(0,accountIds.indexOf(selectedAccount)));LinearLayout.LayoutParams accountFilterParams=new LinearLayout.LayoutParams(verticalFilters?-1:0,-2,verticalFilters?0:1);if(verticalFilters)accountFilterParams.topMargin=dp(8);else accountFilterParams.leftMargin=dp(8);first.addView(account,accountFilterParams);filters.addView(first);
        Set<String> catSet=new java.util.TreeSet<>();for(JSONObject tx:sortedTransactions(state))catSet.add(tx.optString("category"));List<String> categoryNames=new ArrayList<>();categoryNames.add("全部分类");categoryNames.addAll(catSet);Spinner categories=spinner(categoryNames);categories.setSelection(selectedCategory.isEmpty()?0:Math.max(0,categoryNames.indexOf(selectedCategory)));filters.addView(categories);
        actionPair(filters,"＋ 记一笔",()->newTransaction("expense",""),"导出筛选结果 CSV",this::exportCsv);
        LinearLayout results=column();body.addView(results);renderFilteredTransactions(results,state);
        query.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){searchQuery=s.toString();visibleTransactions=100;act(()->renderFilteredTransactions(results,state));}public void afterTextChanged(Editable e){}});
        selected(types,position->{selectedType=typeValues[position];visibleTransactions=100;renderFilteredTransactions(results,state);});
        selected(account,position->{selectedAccount=accountIds.get(position);visibleTransactions=100;renderFilteredTransactions(results,state);});
        selected(categories,position->{selectedCategory=position==0?"":categoryNames.get(position);visibleTransactions=100;renderFilteredTransactions(results,state);});
    }
    private void renderFilteredTransactions(LinearLayout results,JSONObject state)throws Exception {
        results.removeAllViews();List<JSONObject> list=filteredTransactions(state);long income=0,expense=0;String today=LedgerStore.today();for(JSONObject tx:list){if(tx.optString("date").compareTo(today)>0)continue;if(tx.optString("type").equals("income"))income+=MobileLedger.transactionCnyAmount(tx);if(tx.optString("type").equals("expense"))expense+=MobileLedger.transactionCnyAmount(tx);}
        LinearLayout summary=column();summary.setPadding(dp(8),dp(4),dp(8),dp(14));summary.addView(text(list.size()+" 笔账单 · 折合人民币",12,MUTED,false));metrics(summary,new JSONObject().put("income",income).put("expense",expense).put("balance",income-expense));results.addView(summary);
        LinearLayout listCard=column();listCard.setBackground(MobileStyle.material(this,0xFF9AAAC4,22));MobileStyle.softElevation(listCard,2);listCard.setPadding(dp(17),dp(16),dp(17),dp(16));results.addView(listCard);
        if(list.isEmpty()){sectionTitle(listCard,"这里还没有账单","list");listCard.addView(label("试试切换月份或清除筛选，也可以记下今天的第一笔。"));}
        for(int i=0;i<Math.min(visibleTransactions,list.size());i++){if(i>0)divider(listCard);final JSONObject tx=list.get(i);addTransactionRow(listCard,tx,state);listCard.getChildAt(listCard.getChildCount()-1).setOnClickListener(v->act(()->editTransaction(tx,null)));}
        if(list.size()>visibleTransactions)addButton(listCard,"查看更多（还有 "+(list.size()-visibleTransactions)+" 笔）",false,()->{visibleTransactions+=100;renderFilteredTransactions(results,state);});
    }
    private void shiftMonth(int delta)throws Exception {String base=selectedMonth.isEmpty()?LedgerStore.today().substring(0,7):selectedMonth;Calendar c=Calendar.getInstance();c.set(Integer.parseInt(base.substring(0,4)),Integer.parseInt(base.substring(5,7))-1,1);c.add(Calendar.MONTH,delta);int year=c.get(Calendar.YEAR);if(year<1900||year>2199)return;selectedMonth=String.format(Locale.US,"%04d-%02d",year,c.get(Calendar.MONTH)+1);visibleTransactions=100;render();}
    private void chooseMonth(){EditText value=new EditText(this);styleInput(value);value.setSingleLine(true);value.setHint("YYYY-MM");value.setText(selectedMonth);AlertDialog dialog=dialogBuilder().setTitle("选择账单月份").setView(value).setNegativeButton("取消",null).setNeutralButton("全部月份",(d,w)->{selectedMonth="";render();}).setPositiveButton("确定",null).create();dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->act(()->{String month=value.getText().toString().trim();if(!month.matches("(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])"))throw new Exception("请填写有效月份，例如 2026-11");selectedMonth=month;visibleTransactions=100;dialog.dismiss();render();})));dialog.show();MobileStyle.styleDialog(dialog);}
    private interface Selection { void choose(int position)throws Exception; }
    private void selected(Spinner spinner,Selection action){spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onItemSelected(AdapterView<?> parent,View view,int position,long id){act(()->action.choose(position));}public void onNothingSelected(AdapterView<?> parent){}});}
    private void addTransactionRow(LinearLayout parent,JSONObject tx,JSONObject state)throws Exception {
        JSONObject account=findAccount(state,tx.optString("accountId"));String type=tx.optString("type");
        String displayAmount=(type.equals("income")?"+":type.equals("expense")?"−":"⇄ ")+money(tx.optLong("amount"),tx.optString("currency","CNY"));boolean stacked=largeText()||displayAmount.length()>13;
        LinearLayout item=stacked?column():row(),r=stacked?row():item;item.setPadding(0,dp(7),0,dp(7));item.setMinimumHeight(dp(64));item.setFocusable(true);item.setBackground(MobileStyle.ripple(this,Color.WHITE,12));
        addLogo(r,account==null?"":BrandIcons.forAccount(account),account==null?"账":account.optString("name"),account==null?"#6254D9":account.optString("color","#6254D9"),36);
        LinearLayout detail=column();TextView title=text(tx.optString("title","账单"),14,INK,true);detail.addView(title);
        String route=accountName(account);if(type.equals("transfer"))route+=" → "+accountName(findAccount(state,tx.optString("toAccountId")));
        detail.addView(text(tx.optString("date")+" · "+tx.optString("category"),11,MUTED,false));detail.addView(text(route,11,MUTED,false));r.addView(detail,new LinearLayout.LayoutParams(0,-2,1));
        if(stacked)item.addView(r,new LinearLayout.LayoutParams(-1,-2));
        LinearLayout amount=column();amount.setGravity(Gravity.END);amount.setPadding(stacked?0:dp(7),stacked?dp(9):0,0,0);TextView number=text(displayAmount,14,type.equals("income")?GREEN:INK,true);number.setGravity(Gravity.END);amount.addView(number);
        if(!tx.optString("currency","CNY").equals("CNY"))amount.addView(text("≈ "+money(MobileLedger.transactionCnyAmount(tx),"CNY"),10,MUTED,false));
        if(type.equals("transfer")&&tx.has("toAmount"))amount.addView(text("到账 "+money(tx.optLong("toAmount"),tx.optString("toCurrency","CNY")),10,MUTED,false));
        item.addView(amount,new LinearLayout.LayoutParams(stacked?-1:0,-2,stacked?0:.85f));parent.addView(item);
    }
    private void renderAccounts(JSONObject data)throws Exception {
        JSONObject state=data.getJSONObject("state");JSONArray accounts=items(state,"accounts");JSONObject balances=MobileLedger.balances(state,LedgerStore.today());heading("我的资产","每笔收支对应实际账户，转账只移动资产。");
        LinearLayout total=card();total.addView(label("账户总资产 · 折合人民币"));total.setBackground(MobileStyle.heroSurface(this));total.addView(amountText(money(MobileLedger.netWorth(state,LedgerStore.today()),"CNY"),32,INK));actionPair(total,"＋ 添加账户",()->editAccount(null),"账户间转账",()->newTransaction("transfer",""));
        if(accounts.length()==0){LinearLayout empty=card();sectionTitle(empty,"给第一个账户安个家","wallet");empty.addView(label("微信、支付宝、银行卡或现金，选好账户，填写真实余额就能开始。"));}
        for(int i=0;i<accounts.length();i++){final JSONObject account=accounts.getJSONObject(i);String code=account.optString("currency","CNY");long balance=balances.optLong(account.getString("id"));LinearLayout c=card(),top=row();c.setBackground(MobileStyle.material(this,safeColor(account.optString("color","#8C7BC1")),22));addLogo(top,BrandIcons.forAccount(account),account.optString("name"),account.optString("color","#6254D9"),44);LinearLayout title=column();title.addView(text(accountName(account),17,INK,true));title.addView(text(account.optString("type")+" · "+code,11,MUTED,false));top.addView(title,new LinearLayout.LayoutParams(0,-2,1));top.addView(link("管理 ›",()->editAccount(account)));c.addView(top);gap(c,16);c.addView(text("当前余额",11,MUTED,false));gap(c,5);c.addView(amountText(money(balance,code),31,INK));
            if(!code.equals("CNY"))c.addView(label("≈ "+money(MobileLedger.toCnyCents(balance,code,account.optString("cnyRate")),"CNY")+" · 汇率 "+account.optString("cnyRate")+" CNY / "+code));
            c.addView(text("期初 "+money(account.optLong("openingBalance"),code)+" · 当前余额已计入账单",11,MUTED,false));actionPair(c,"从此账户记账",()->newTransaction("expense",account.getString("id")),"查看明细",()->{selectedAccount=account.getString("id");selectedMonth="";selectedCategory="";selectedType="";searchQuery="";page=1;render();});}
    }
    private void renderMore(JSONObject data)throws Exception {
        if(!moreSection.isEmpty()){Button back=button("‹ 返回更多",false,()->{moreSection="";render();});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-2,-2);p.bottomMargin=dp(12);body.addView(back,p);
            switch(moreSection){case "sync":renderSync(data);return;case "review":renderReview(data);return;case "subscriptions":renderSubscriptions(data);return;case "goals":renderGoals(data);return;case "budget":renderBudget(data);return;case "data":renderDataTools(data);return;default:moreSection="";}}
        heading("把生活安排得更清楚","订阅、预算与心愿，都与电脑账本互通。");int pending=items(data,"pending").length()+items(data,"conflicts").length();
        menuCard("扫码同步","同一 Wi-Fi / 热点，增量合并两端修改","sync","⇄");
        menuCard("待确认",pending==0?"目前没有待确认项目":pending+" 项通知或同步冲突需要处理","review","?");
        menuCard("会员订阅",items(data.getJSONObject("state"),"subscriptions").length()+" 项计划 · 到期自动记账，不发起支付","subscriptions","订");
        menuCard("月度预算","查看剩余额度与分类支出","budget","预");
        menuCard("储蓄心愿",items(data.getJSONObject("state"),"goals").length()+" 个目标，记录每一步进展","goals","愿");
        menuCard("导入与导出","手机完整备份、恢复与 CSV 账单导出","data","存");
    }
    private void menuCard(String title,String subtitle,String section,String glyph) {
        String symbol = section.equals("sync") ? "sync" : section.equals("review") ? "check" : section.equals("subscriptions") ? "calendar" : section.equals("budget") ? "chart" : section.equals("goals") ? "goal" : "shield";
        LinearLayout panel = card(), r = row(); FrameLayout stamp = new FrameLayout(this); stamp.setBackground(MobileStyle.material(this, PURPLE, 14)); stamp.addView(icon(symbol, PURPLE, 22), new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(46), dp(46)); size.rightMargin = dp(13); r.addView(stamp, size);
        LinearLayout labels = column(); labels.addView(text(title,17,INK,true)); labels.addView(text(subtitle,12,MUTED,false)); r.addView(labels,new LinearLayout.LayoutParams(0,-2,1));
        LinearLayout.LayoutParams arrow = new LinearLayout.LayoutParams(dp(18),dp(18)); arrow.leftMargin=dp(8); r.addView(icon("chevron",MUTED,18),arrow); panel.addView(r); panel.setBackground(MobileStyle.cardRipple(this,0xFF9AAAC4,22)); panel.setContentDescription(title+"，"+subtitle); panel.setFocusable(true); panel.setOnClickListener(v->openMore(section));
    }
    private void renderDataTools(JSONObject data)throws Exception {heading("数据握在自己手里","手机完整备份包含待同步操作与待确认通知。");LinearLayout c=card();c.addView(text("手机完整备份",18,INK,true));c.addView(label("导出 JSON 保存到你选的位置。恢复前会留存当前手机内容，恢复后请先核对账本和同步状态。"));addButton(c,"导出手机完整备份",true,()->exportBackup(false));addButton(c,"从手机备份恢复",false,this::importBackup);LinearLayout csv=card();csv.addView(text("CSV 账单明细",18,INK,true));csv.addView(label("按账单页当前月份、账户、分类与搜索条件导出；金额保留原币，并提供人民币参考金额。"));addButton(csv,"筛选并导出 CSV",false,()->{page=1;render();});}
    private void renderReview(JSONObject data) throws Exception {
        heading("确认一下，更安心","账户不明、退款和疑似重复的交易，会先留在这里。");
        JSONArray conflicts = data.getJSONArray("conflicts"), pending = data.getJSONArray("pending"), operations = data.getJSONArray("operations");
        for (int i = 0; i < conflicts.length(); i++) {
            final JSONObject conflict = conflicts.getJSONObject(i); JSONObject op = null; for (int j = 0; j < operations.length(); j++) if (conflict.optString("operationId").equals(operations.getJSONObject(j).optString("id"))) op = operations.getJSONObject(j);
            if (op == null) continue;
            final JSONObject operation = op; LinearLayout c = card(); c.addView(text(conflict.optBoolean("retryWhenFunded")?"余额不足，待补款":"同步需要确认", 17, RED, true)); c.addView(label(conflict.optString("reason", "两端记录有变化")));
            JSONObject phone = op.optJSONObject("record"); if (phone == null) phone = op.optJSONObject("transaction"); if (phone == null) phone = op.optJSONObject("base"); if (phone != null) c.addView(text((op.optString("kind").equals("delete") ? "手机希望删除：" : "手机记录：") + recordDescription(op.optString("entity", "transaction"), phone), 14, INK, false));
            JSONObject candidate = conflict.optJSONObject("candidate"), current = conflict.optJSONObject("current"); JSONObject shown = candidate != null ? candidate : current;
            if (shown != null) c.addView(label("电脑记录：" + recordDescription(op.optString("entity", "transaction"), shown)));
            if(conflict.optBoolean("retryWhenFunded"))c.addView(label("补足账户余额后再次同步，待扣账期会自动处理。"));
            else addButton(c, "查看处理方式", false, () -> resolveConflict(conflict, operation));
        }
        for (int i = 0; i < pending.length(); i++) {
            final JSONObject item = pending.getJSONObject(i), tx = item.getJSONObject("transaction"); LinearLayout c = card(), title = row(); addLogo(title, BrandIcons.forSource(item.optString("sourcePackage")), sourceName(data, item.optString("sourcePackage")), "#8476D9", 38); title.addView(text(tx.optString("title", "付款通知"), 18, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); c.addView(title); c.addView(text(tx.optLong("amount") <= 0 ? "金额待确认" : money(tx.optLong("amount"), tx.optString("currency", "CNY")), 25, PURPLE, true)); c.addView(label(item.optString("reason"))); c.addView(text(tx.optString("date") + " · " + sourceName(data, item.optString("sourcePackage")), 12, MUTED, false));
            String details = captureDetails(tx); if (!details.isEmpty()) c.addView(label(details));
            addButton(c, "核对并入账", true, () -> editTransaction(tx, item)); addButton(c, "忽略这条通知", false, () -> dialogBuilder().setTitle("忽略这条通知？").setMessage("它不会进入账本。若是已记录的消费或账户间转账，可以忽略。").setNegativeButton("返回", null).setPositiveButton("忽略", (d, w) -> act(() -> { store.dismissPending(item.getString("id")); render(); })).show());
        }
        if (pending.length() + conflicts.length() == 0) { LinearLayout empty = card(); sectionTitle(empty,"全部处理好了","check"); empty.addView(label("新收到的付款通知会自动识别。需要你确认时，这里会显示提醒。")); }
    }
    private String captureDetails(JSONObject tx) {
        JSONObject capture = tx.optJSONObject("mobileCapture"); if (capture == null) return "";
        List<String> parts = new ArrayList<>(); String channel = capture.optString("paymentChannel"), funding = capture.optString("fundingSource");
        if (channel.equals("wechat")) parts.add("付款渠道：微信"); else if (channel.equals("alipay")) parts.add("付款渠道：支付宝"); else if (channel.equals("bank")) parts.add("银行交易通知");
        if (funding.equals("bank")) parts.add("资金来源：银行卡"); else if (funding.equals("wallet")) parts.add("资金来源：零钱 / 余额"); else if (funding.equals("credit")) parts.add("资金来源：信用支付，请核对");
        if (!capture.optString("bankName").isEmpty()) parts.add(capture.optString("bankName")); if (!capture.optString("lastFour").isEmpty()) parts.add("尾号 " + capture.optString("lastFour"));
        JSONArray amounts = capture.optJSONArray("amountCandidates"); if (amounts != null && amounts.length() > 1) { StringBuilder values = new StringBuilder("页面 / 通知中的候选金额："); for (int i = 0; i < Math.min(8, amounts.length()); i++) { if (i > 0) values.append("、"); values.append(money(amounts.optLong(i), "CNY")); } parts.add(values.toString()); }
        if (capture.optString("captureMethod").equals("screen")) parts.add("付款页面辅助识别 · 请确认实际支付金额"); return String.join("\n", parts);
    }
    private String recordDescription(String entity, JSONObject record) {
        if (entity.equals("settings")) return "每月预算 " + money(record.optLong("monthlyBudget"), "CNY");
        if (entity.equals("account")) return "账户 " + record.optString("name") + " · " + record.optString("currency", "CNY");
        if (entity.equals("goal")) return "心愿 " + record.optString("name") + " · 目标 " + money(record.optLong("target"), "CNY");
        return record.optString("date") + " " + record.optString("title", record.optString("name")) + " " + money(record.optLong("amount"), record.optString("currency", "CNY"));
    }
    private void resolveConflict(JSONObject conflict, JSONObject operation) throws Exception {
        boolean duplicate = conflict.optJSONObject("candidate") != null;
        boolean canKeepPhone = conflict.optBoolean("canKeepPhone", true);
        AlertDialog.Builder choices = dialogBuilder().setTitle(duplicate ? "这是不是同一笔消费？" : "选择保留的修改")
            .setMessage(conflict.optString("reason") + (!canKeepPhone ? "\n" + conflict.optString("resolutionHint", "请采用电脑记录，再编辑账本中已有的那一笔。") : duplicate ? "\n确定是两笔不同交易时，才选择保留两笔。" : "\n手机修改会以当前电脑记录为基础，下一次扫码时再提交。"))
            .setNegativeButton("稍后处理", null)
            .setNeutralButton(duplicate ? "同一笔，采用电脑" : "采用电脑记录", (d, w) -> act(() -> { store.resolveConflict(operation.getString("id"), false); render(); }));
        if (canKeepPhone) choices.setPositiveButton(duplicate ? "保留两笔" : "保留手机修改", (d, w) -> act(() -> { store.resolveConflict(operation.getString("id"), true); render(); toast("已处理，下次扫码时提交"); }));
        choices.show();
    }
    private void renderSync(JSONObject data) throws Exception {
        heading("回到电脑旁，一扫同步","在外记账 · 本地保存 · 回来补齐");
        LinearLayout steps = card(); sectionTitle(steps,"连接你的电脑","sync"); gap(steps, 10); steps.addView(text("01  手机和电脑连接同一 Wi-Fi / 热点\n\n02  电脑端打开「手机同步」\n\n03  扫描电脑显示的临时二维码", 15, INK, false)); gap(steps, 14); steps.addView(label("不需要云端账号。二维码只用于临时配对，账本内容加密传输。关闭电脑同步窗口或二维码过期后，需要重新扫码。"));
        Button scan = button(store.isSyncing() ? "正在同步…" : "扫一扫，开始同步", true, () -> startActivityForResult(new Intent(this, ScanActivity.class), 31)); scan.setEnabled(!store.isSyncing()); steps.addView(scan, new LinearLayout.LayoutParams(-1, -2)); addButton(steps, "粘贴配对内容", false, this::pastePairing);
        if (!syncMessage.isEmpty()) { LinearLayout result = card(); result.addView(text(store.isSyncing() ? "正在连接" : "同步结果", 18, INK, true)); result.addView(label(syncMessage)); }
        int funding=fundingWaitCount(data);
        LinearLayout state = card(); sectionTitle(state,"同步状态","shield"); state.addView(label("上次成功：" + when(data.optLong("lastSyncAt")) + "\n待上传修改：" + data.getJSONArray("operations").length() + " 项\n待处理通知：" + data.getJSONArray("pending").length() + " 条\n需要确认的冲突：" + (data.getJSONArray("conflicts").length()-funding) + " 项\n等待补款的账期：" + funding + " 项"));
        state.addView(label("同步中断不会删除手机记录。信息不明确的通知留在手机待确认，核对入账后才上传。账户、外币、转账、订阅、预算和心愿都可在手机管理，并同步到电脑 1.7.0 及以上版本。"));
        if (!data.isNull("bookId")) addButton(state, "连接另一份电脑账本", false, () -> dialogBuilder().setTitle("切换电脑账本？").setMessage("仅在没有待同步修改时可以切换。手机会清除已下载的电脑账本和账户映射；待确认通知保留。原电脑上的数据不受影响。").setNegativeButton("取消", null).setPositiveButton("切换", (d, w) -> act(() -> { store.reconnectEmpty(); pairing = null; render(); })).show());
        addButton(state, "导出手机完整备份", false, () -> exportBackup(false));
        if (!data.isNull("bookId")) addButton(state, "电脑账本已重置 / 恢复配对", false, () -> dialogBuilder().setTitle("先保留手机备份").setMessage("适用于电脑账本已重置、导入或更换，无法再同步旧队列的情况。请先导出完整手机备份，再选择是否恢复配对；此时不会丢弃任何手机记录。").setNegativeButton("取消", null).setPositiveButton("先导出备份", (d, w) -> act(() -> exportBackup(true))).show());
    }
    private int fundingWaitCount(JSONObject data)throws Exception {
        JSONArray conflicts=items(data,"conflicts");int count=0;
        for(int i=0;i<conflicts.length();i++)if(conflicts.getJSONObject(i).optBoolean("retryWhenFunded"))count++;
        return count;
    }
    private void pastePairing() { EditText input = new EditText(this); styleInput(input); input.setHint("粘贴电脑端的配对内容"); input.setMinLines(3); input.setMaxLines(8); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); dialogBuilder().setTitle("手动配对").setView(input).setNegativeButton("取消", null).setPositiveButton("同步", (d, w) -> act(() -> startSync(input.getText().toString()))).show(); }
    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code == AppUpdater.INSTALL_PERMISSION_REQUEST && updater != null) updater.permissionReturned();
        if (code == AppUpdater.INSTALL_CONFIRM_REQUEST && updater != null) updater.installerReturned();
        if (code == 31 && result == RESULT_OK && intent != null) act(() -> startSync(intent.getStringExtra("pairing")));
        if (code == 45 && result == RESULT_OK && intent != null && intent.getData() != null) act(() -> {
            final Uri uri = intent.getData(); final String csv = csvText(store.snapshot().getJSONObject("state"));
            new Thread(() -> { try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) { if (output == null) throw new Exception("无法打开导出位置"); output.write(csv.getBytes(StandardCharsets.UTF_8)); output.flush(); runOnUiThread(() -> { if (!destroyed) toast("CSV 账单已保存"); }); } catch (Exception failure) { runOnUiThread(() -> { if (!destroyed) error(failure.getMessage()); }); } }, "ledger-csv-export").start();
        });
        if (code == 46 && result == RESULT_OK && intent != null && intent.getData() != null) readBackup(intent.getData());
        if (code == 44 && result == RESULT_OK && intent != null && intent.getData() != null) act(() -> {
            try (OutputStream output = getContentResolver().openOutputStream(intent.getData(), "wt")) { if (output == null) throw new Exception("无法打开备份位置"); output.write(store.snapshot().toString(2).getBytes(StandardCharsets.UTF_8)); output.flush(); }
            toast("手机完整备份已保存");
            if (recoveryAfterExport) dialogBuilder().setTitle("备份完成，恢复配对？").setMessage("旧账单的未同步新增/修改会转入待确认，需重新选择账户后手动入账。账户、订阅、预算、心愿及删除操作完整保存在手机归档和刚导出的备份中，不会自动写入或删除新账本的数据。已下载的旧电脑账本和账户映射将清除。")
                .setNegativeButton("先不恢复", null).setPositiveButton("存档并重新配对", (d, w) -> act(() -> { store.archiveForReconnect(); pairing = null; syncMessage = "旧队列已存档。请扫描电脑新二维码，再处理待确认中的旧账单。"; render(); })).show();
            recoveryAfterExport = false;
        });
    }
    private void exportBackup(boolean recovery) throws Exception {
        if (store.isSyncing()) throw new Exception("正在同步，请完成后再导出备份"); recoveryAfterExport = recovery;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "超级账本-手机备份-" + LedgerStore.today() + ".json"); startActivityForResult(intent, 44);
    }
    private void startSync(String raw) throws Exception {
        final SyncClient.Pairing selected = SyncClient.parsePairing(raw); JSONObject data = store.snapshot();
        if (data.isNull("bookId") && (data.getJSONArray("operations").length() > 0 || data.getJSONObject("state").getJSONArray("accounts").length() > 0)) {
            dialogBuilder().setTitle("合并手机内容到电脑？").setMessage("这是首次连接。手机现有账户、账单和其他修改将加入电脑账本；同名账户会分别保留，不会自动视为同一账户。建议先导出手机备份，并确认电脑已更新到 1.7.0 或以上。")
                .setNegativeButton("暂不同步", null).setPositiveButton("确认合并并同步", (d, w) -> act(() -> startSyncConfirmed(selected))).show();
        } else startSyncConfirmed(selected);
    }
    private void startSyncConfirmed(SyncClient.Pairing selected) throws Exception {
        pairing = selected; store.startSync(); page = 3; moreSection = "sync"; syncMessage = "正在连接电脑，并安全交换账本…"; render();
        new Thread(() -> {
            String result;
            try {
                int added = 0, updated = 0, deleted = 0, duplicates = 0, rounds = 0;
                while (true) {
                    JSONObject request = store.syncRequest(UUID.randomUUID().toString());
                    JSONObject response = SyncClient.synchronize(selected, request); store.applyResponse(response, request);
                    JSONObject summary = response.optJSONObject("summary"); if (summary != null) { added += summary.optInt("added"); updated += summary.optInt("updated"); deleted += summary.optInt("deleted"); duplicates += summary.optInt("duplicates"); }
                    rounds++; if (rounds >= 20 || store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").length() == 0) break;
                }
                JSONObject latest = store.snapshot();int funding=fundingWaitCount(latest); result = "同步完成\n新增 " + added + " 笔 · 更新 " + updated + " 笔 · 删除 " + deleted + " 笔\n已去重 " + duplicates + " 笔 · 待确认冲突 " + (latest.getJSONArray("conflicts").length()-funding) + " 项\n等待补款的账期 " + funding + " 项 · 剩余待上传 " + latest.getJSONArray("operations").length() + " 项";
            } catch (Exception e) { result = "同步尚未完成\n" + (e.getMessage() == null ? "请检查连接后重试" : e.getMessage()); }
            finally { store.endSync(); }
            sendBroadcast(new Intent(ACTION_CHANGED).setPackage(getPackageName()));
            final String message = result; runOnUiThread(() -> { if (destroyed) return; syncMessage = message; render(); });
        }, "ledger-local-sync").start();
    }
    private boolean notificationGranted() {
        String allowed = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners"); if (allowed == null) return false;
        for (String name : allowed.split(":")) { ComponentName component = ComponentName.unflattenFromString(name); if (component != null && component.getPackageName().equals(getPackageName())) return true; } return false;
    }
    private boolean screenCaptureGranted() {
        String allowed = Settings.Secure.getString(getContentResolver(), "enabled_accessibility_services"); if (allowed == null) return false;
        ComponentName expected = new ComponentName(getPackageName(), getPackageName() + ".PaymentAccessibilityService");
        for (String name : allowed.split(":")) if (expected.equals(ComponentName.unflattenFromString(name))) return true; return false;
    }
    private static String sourceName(JSONObject data, String pkg) { JSONObject source = data.optJSONObject("sources").optJSONObject(pkg); return source == null ? pkg : source.optString("name", pkg); }
    private void renderSettings(JSONObject data) throws Exception {
        heading("按你的习惯，轻松记账","权限由你开启，自动识别范围由你决定。");
        renderUpdates();
        LinearLayout automatic = card(); LinearLayout switchRow = row(); switchRow.addView(text("自动记账总开关", 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); Switch capture = new Switch(this); capture.setChecked(data.optBoolean("captureEnabled")); switchRow.addView(capture); automatic.addView(switchRow);
        automatic.addView(label("仅处理你选中的支付/银行应用交易通知；普通聊天和验证码不入账。明确金额但账户不明的通知进入待确认。系统没有提供的内容无法读取。"));
        capture.setOnCheckedChangeListener((v, checked) -> { if (!checked) act(() -> { store.setCapture(false); render(); }); else dialogBuilder().setTitle("开启付款通知识别")
            .setMessage("系统的通知访问权限范围较广。超级账本只在本机筛选你选中应用的财务通知，用于记账；不会上传普通聊天或验证码。需要确认的交易摘要只保存在手机，入账后移除摘要。你可随时关闭采集或在系统设置撤销权限。")
            .setNegativeButton("暂不开启", (d, w) -> render()).setPositiveButton("开启并授权", (d, w) -> act(() -> { store.setCapture(true); if (!notificationGranted()) startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); else render(); })).setOnCancelListener(d -> render()).show(); });
        automatic.addView(text(notificationGranted() ? "● 通知访问已授权" : "○ 通知访问尚未授权", 13, notificationGranted() ? GREEN : RED, true)); addButton(automatic, "打开系统通知权限", false, () -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        automatic.addView(label("最近识别：" + (data.optLong("lastCaptureAt") == 0 ? "尚无交易通知" : when(data.optLong("lastCaptureAt")))));
        if (!data.optString("captureError").isEmpty()) automatic.addView(text(data.optString("captureError"), 13, RED, true));
        LinearLayout screen = card(), screenRow = row(); screenRow.addView(text("付款页面辅助识别", 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); Switch screenToggle = new Switch(this); screenToggle.setChecked(data.optBoolean("screenCaptureEnabled", false)); screenRow.addView(screenToggle); screen.addView(screenRow);
        screen.addView(label("可选功能，默认关闭。只在你打开微信、支付宝的付款成功页时，本机提取实付金额、商家与付款方式；不会点击付款，不保留整页内容。用于补充没有通知的扫码消费，不能保证识别每一笔。"));
        boolean screenReady = data.optBoolean("captureEnabled") && data.optBoolean("screenCaptureEnabled") && screenCaptureGranted();
        screen.addView(text(screenReady ? "● 页面辅助识别已就绪" : screenCaptureGranted() ? "○ 系统服务已授权，仍需同时打开两个开关" : "○ 系统辅助服务尚未授权", 13, screenReady ? GREEN : MUTED, true));
        screenToggle.setOnCheckedChangeListener((v, enabled) -> { if (!enabled) act(() -> { store.setScreenCaptureEnabled(false); render(); }); else dialogBuilder().setTitle("允许付款页面辅助识别？")
            .setMessage("开启后，还需你在系统无障碍设置中手动启用超级账本服务。服务仅检查微信和支付宝的付款结果页面，不操作其他应用、不点击支付、不上传页面。所有付款页面识别结果先进入待确认，由你核对金额与账户后入账。你可以随时关闭本开关或系统服务。")
            .setNegativeButton("暂不开启", (d, w) -> render()).setPositiveButton("了解，前往系统设置", (d, w) -> act(() -> { store.setScreenCaptureEnabled(true); startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); })).setOnCancelListener(d -> render()).show(); });
        addButton(screen, "打开系统辅助服务设置 / 关闭授权", false, () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        LinearLayout sources = card(); sectionTitle(sources,"付款来源与账户","wallet"); sources.addView(label("点选来源，设置实际扣款账户。微信/支付宝也可能使用银行卡，切换支付方式后请核对映射；未指定账户时会进入待确认。银行卡尾号能唯一匹配时优先采用尾号。"));
        JSONObject sourceMap = data.getJSONObject("sources"); List<String> packages = new ArrayList<>(); Iterator<String> keys = sourceMap.keys(); while (keys.hasNext()) packages.add(keys.next()); Collections.sort(packages);
        for (String pkg : packages) {
            JSONObject info = sourceMap.getJSONObject(pkg); LinearLayout r = row(); r.setPadding(0, dp(12), 0, dp(10)); addLogo(r, BrandIcons.forSource(pkg), info.optString("name", pkg), "#8476D9", 36); LinearLayout desc = column(); desc.addView(text(info.optString("name", pkg), 15, INK, true)); String mapped = data.getJSONObject("mappings").optString(pkg); desc.addView(text((info.optBoolean("enabled") ? "已启用" : "已停用") + " · " + (mapped.isEmpty() ? "待确认账户" : accountName(findAccount(data.getJSONObject("state"), mapped))), 11, MUTED, false)); r.addView(desc, new LinearLayout.LayoutParams(0, -2, 1)); r.addView(text("设置 ›", 12, PURPLE, true)); r.setOnClickListener(v -> act(() -> sourceSettings(pkg))); sources.addView(r);
        }
        addButton(sources, "添加其他银行 / 短信应用", false, this::chooseSourceApp);
        LinearLayout help = card(); sectionTitle(help,"vivo 手机使用提示","settings"); help.addView(label("请在系统设置中允许超级账本后台运行和自启动，避免省电清理导致漏记。设置名称以你的系统版本为准。若「通知使用权」不可选，查看应用信息菜单中的受限设置提示。\n\n付款应用需要实际发出含金额的通知。现金、未显示金额的通知及系统隐藏的信息需要手工补记或在电脑对账。银行短信可选择短信应用作为来源，前提是通知显示银行交易内容。")); addButton(help, "打开本应用系统设置", false, () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        LinearLayout privacy = card(); sectionTitle(privacy,"本地优先，随时可控","shield"); privacy.addView(label("手机记录保存在应用私有目录，关闭系统云备份。账本只通过扫码连接的局域网传输，并使用临时配对密钥加密。更新功能会通过手机的正常 HTTPS / 系统代理设置，从 GitHub 或所选免费中转线路请求公开版本与安装包，仍需校验原签名，不读取或上传账本。卸载应用会删除手机数据，请先完成电脑同步或导出备份；正常覆盖升级保留数据。\n\n手机版 " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName + " · 支持多币种账户、收入支出、账户转账、订阅、预算和心愿。所显示余额由期初余额与账单计算，应用不会读取银行真实余额，也不会发起付款。"));
    }
    private void renderUpdates() {
        if (updater == null) return;
        updatePanel = card(); refreshUpdateCard(updater.snapshot());
    }
    private String currentVersion() { try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { return "—"; } }
    private String updateSourceName(String mode) {
        if ("github".equals(mode)) return "GitHub 官方";
        if ("gh-proxy".equals(mode)) return "备用线路一 · GH-Proxy";
        if ("ghfast".equals(mode)) return "备用线路二 · GHFast";
        return "自动切换";
    }
    private void chooseUpdateSource() throws Exception {
        if (updater.snapshot().busy) throw new Exception("请先完成或取消当前更新，再更换线路");
        String[] modes = {"auto", "github", "gh-proxy", "ghfast"};
        String[] names = {"自动切换（推荐）", "GitHub 官方", "备用线路一 · GH-Proxy", "备用线路二 · GHFast"};
        int current = Math.max(0, Arrays.asList(modes).indexOf(updater.getSourceMode()));
        dialogBuilder().setTitle("选择更新线路").setSingleChoiceItems(names, current, (dialog, selected) -> act(() -> {
            updater.setSourceMode(modes[selected]); dialog.dismiss(); refreshUpdateCard(updater.snapshot());
            toast("更新线路已设为" + updateSourceName(modes[selected]));
        })).setNegativeButton("取消", null).show();
    }
    private void refreshUpdateCard(AppUpdater.Snapshot update) {
        if (updatePanel == null) return;
        String key = update.phase + "|" + update.version + "|" + update.message + "|" + update.busy + "|" + update.canInstall + "|" + update.canDownload + "|" + update.checkedAt + "|" + update.sourceMode + "|" + update.sourceLabel;
        if (!key.equals(updateCardKey)) {
            updateCardKey = key; updatePanel.removeAllViews(); updateProgressLabel = null; updateProgressBar = null;
            sectionTitle(updatePanel, "应用更新", "download");
            String title = update.phase.equals("downloading") ? "新版本正在路上" : update.canInstall ? "新版本，准备好了" : update.canDownload ? "发现新版本 v" + update.version : update.phase.equals("checking") ? "正在寻找新变化" : update.phase.equals("installing") ? "正在打开安装程序" : update.message.equals("当前已是最新版本。") ? "已经是最新版本" : "保持更新，轻松记账";
            updatePanel.addView(text(title, 18, INK, true)); updatePanel.addView(label(update.message));
            if (update.phase.equals("downloading")) {
                updateProgressLabel = text("", 13, PURPLE, true); updatePanel.addView(updateProgressLabel);
                updateProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); updateProgressBar.setMax(1000); updateProgressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(PURPLE)); updateProgressBar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(PURPLE)); updateProgressBar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(LINE));
                LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(-1,dp(8)); barParams.topMargin=dp(9); barParams.bottomMargin=dp(5); updatePanel.addView(updateProgressBar,barParams);
                actionPair(updatePanel,"查看下载",()->mobileUpdates.show(),"取消下载",()->updater.cancelDownload());
            } else if (update.canInstall || update.canDownload) addButton(updatePanel,"查看更新",true,()->mobileUpdates.show());
            if (update.canDownload || update.phase.equals("downloading")) {
                addButton(updatePanel,"浏览器下载",false,()->updater.openDownloadInBrowser(this));
                updatePanel.addView(label("浏览器使用所选线路；连接不畅时，可先取消，再更换线路重试。"));
            }
            Button check = button(update.busy ? "正在处理更新…" : "检查更新", false, () -> mobileUpdates.check()); check.setEnabled(!update.busy);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1,-2); params.topMargin=dp(10); updatePanel.addView(check,params);
            Button route = button("更新线路：" + updateSourceName(update.sourceMode) + "  ›", false, this::chooseUpdateSource); route.setEnabled(!update.busy);
            LinearLayout.LayoutParams routeParams = new LinearLayout.LayoutParams(-1,-2); routeParams.topMargin=dp(10); updatePanel.addView(route,routeParams);
            if (update.sourceLabel != null && !update.sourceLabel.isEmpty()) updatePanel.addView(text((update.busy ? "当前线路 · " : "最近使用 · ") + update.sourceLabel,11,MUTED,false));
            gap(updatePanel,7); updatePanel.addView(text("免费中转仅请求公开更新文件，安装前仍会校验；线路可用性可能变化。",11,MUTED,false));
            divider(updatePanel); updatePanel.addView(text("Android v" + currentVersion() + (update.version.isEmpty() ? "" : "   →   v" + update.version),12,MUTED,false));
            updatePanel.addView(text("每次打开自动检查 · 上次成功 " + (update.checkedAt==0?"尚未检查":when(update.checkedAt)),11,MUTED,false));
            gap(updatePanel,7); updatePanel.addView(text("覆盖升级，保留现有账本与设置。",11,MUTED,false));
        }
        if (updateProgressLabel != null) {
            int percentage = update.size > 0 ? (int)Math.min(100, Math.max(0, update.downloaded * 100 / update.size)) : 0;
            boolean connecting = update.downloaded <= 0;
            updateProgressLabel.setText(connecting ? "正在连接下载服务器…" : String.format(Locale.CHINA,"%.1f / %.1f MB · %d%%",update.downloaded/1048576.0,update.size/1048576.0,percentage));
            if (updateProgressBar != null) { updateProgressBar.setIndeterminate(connecting || update.size <= 0); updateProgressBar.setProgress(percentage * 10); }
        }
    }
    private List<JSONObject> cnyAccounts(JSONObject state) throws Exception { List<JSONObject> accounts = new ArrayList<>(); JSONArray array = state.getJSONArray("accounts"); for (int i = 0; i < array.length(); i++) if (array.getJSONObject(i).optString("currency", "CNY").equals("CNY")) accounts.add(array.getJSONObject(i)); return accounts; }
    private Spinner spinner(List<String> labels) {
        Spinner spinner = new Spinner(this); ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, labels) {
            @Override public View getView(int position, View recycled, ViewGroup parent) {
                TextView view = (TextView)super.getView(position,recycled,parent); view.setText(getItem(position) + "  ▾"); view.setTextColor(INK); view.setTextSize(14); view.setSingleLine(false); view.setMaxLines(Integer.MAX_VALUE); view.setPadding(dp(12),dp(12),dp(10),dp(12)); view.setMinimumHeight(dp(48)); return view;
            }
            @Override public View getDropDownView(int position, View recycled, ViewGroup parent) {
                TextView view = (TextView)super.getDropDownView(position,recycled,parent); view.setTextColor(INK); view.setTextSize(15); view.setSingleLine(false); view.setMaxLines(Integer.MAX_VALUE); view.setPadding(dp(16),dp(12),dp(16),dp(12)); view.setMinimumHeight(dp(48)); return view;
            }
        };
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); spinner.setAdapter(adapter); spinner.setMinimumHeight(dp(48)); spinner.setBackground(MobileStyle.inputSurface(this));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1,-2); params.topMargin=dp(3); params.bottomMargin=dp(8); spinner.setLayoutParams(params); return spinner;
    }
    private void sourceSettings(String pkg) throws Exception {
        JSONObject data = store.snapshot(), source = data.getJSONObject("sources").getJSONObject(pkg); List<JSONObject> accounts = cnyAccounts(data.getJSONObject("state"));
        LinearLayout view = column(); view.setPadding(dp(20), dp(8), dp(20), dp(10)); Switch enabled = new Switch(this); enabled.setText("识别这个应用的交易通知"); enabled.setChecked(source.optBoolean("enabled")); view.addView(enabled); view.addView(label("没有尾号时使用的实际扣款账户")); List<String> names = new ArrayList<>(); names.add("每次待确认（不自动选账户）"); int selected = 0;
        for (int i = 0; i < accounts.size(); i++) { names.add(accountName(accounts.get(i))); if (accounts.get(i).optString("id").equals(data.getJSONObject("mappings").optString(pkg))) selected = i + 1; }
        Spinner mapping = spinner(names); mapping.setSelection(selected); view.addView(mapping); view.addView(label("更换银行卡、零钱或余额付款时，请更新这里的账户。二维码同步不会替你读取真实余额。"));
        dialogBuilder().setTitle(source.optString("name", pkg)).setView(view).setNegativeButton("取消", null).setPositiveButton("保存", (d, w) -> act(() -> { int index = mapping.getSelectedItemPosition(); store.setSource(pkg, source.optString("name", pkg), enabled.isChecked(), index > 0 ? accounts.get(index - 1).getString("id") : ""); render(); })).show();
    }
    private void chooseSourceApp() throws Exception {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER); List<ResolveInfo> apps = getPackageManager().queryIntentActivities(intent, 0); Collections.sort(apps, (a, b) -> a.loadLabel(getPackageManager()).toString().compareToIgnoreCase(b.loadLabel(getPackageManager()).toString())); List<String> names = new ArrayList<>(), packages = new ArrayList<>();
        for (ResolveInfo app : apps) { String pkg = app.activityInfo.packageName; if (packages.contains(pkg) || pkg.equals(getPackageName())) continue; packages.add(pkg); names.add(app.loadLabel(getPackageManager()).toString()); }
        if (names.isEmpty()) throw new Exception("没有读取到可选应用，请先安装并打开需要记录的银行应用");
        dialogBuilder().setTitle("选择付款 / 银行 / 短信应用").setItems(names.toArray(new String[0]), (dialog, index) -> act(() -> { store.setSource(packages.get(index), names.get(index), true, ""); sourceSettings(packages.get(index)); render(); })).setNegativeButton("取消", null).show();
    }
    private void styleInput(EditText input) { input.setTextColor(INK); input.setHintTextColor(MUTED); input.setTextSize(16); input.setMinimumHeight(dp(52)); input.setPadding(dp(13),dp(12),dp(13),dp(12)); input.setBackground(MobileStyle.inputSurface(this)); }
    private EditText field(LinearLayout form, String name, String value, int inputType) {
        TextView caption=label(name); caption.setTextColor(INK); form.addView(caption); EditText input = new EditText(this); input.setId(View.generateViewId()); caption.setLabelFor(input.getId()); input.setText(value); input.setInputType(inputType); styleInput(input);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.bottomMargin = dp(13); form.addView(input, p); return input;
    }
    private String requiredText(EditText input, String label, int limit) throws Exception { String value = input.getText().toString().trim(); if (value.isEmpty()) throw new Exception("请填写" + label); if (value.length() > limit) throw new Exception(label + "最多 " + limit + " 个字符"); return value; }
    private long positiveMoney(EditText input, String currency) throws Exception { long value = MobileLedger.parseMoney(input.getText().toString().trim(), currency); if (value <= 0) throw new Exception("金额必须大于 0，请填写实际金额"); return value; }
    private long nonNegativeMoney(EditText input, String currency) throws Exception { long value = MobileLedger.parseMoney(input.getText().toString().trim(), currency); if (value < 0) throw new Exception("此项金额不能为负数"); return value; }
    private List<JSONObject> allAccounts(JSONObject state)throws Exception {List<JSONObject> result=new ArrayList<>();JSONArray accounts=items(state,"accounts");for(int i=0;i<accounts.length();i++)result.add(accounts.getJSONObject(i));return result;}
    private void newTransaction(String type,String accountId)throws Exception {editTransaction(null,null,type,accountId);}
    private void editTransaction(JSONObject original,JSONObject pending)throws Exception {editTransaction(original,pending,original==null?"expense":original.optString("type","expense"),original==null?"":original.optString("accountId"));}
    private LinearLayout form(){LinearLayout layout=column();layout.setPadding(dp(22),dp(8),dp(22),dp(8));return layout;}
    private void formDialog(String title,LinearLayout form,Action save,Action remove,String deleteMessage){
        ScrollView scroll=new ScrollView(this);scroll.setClipToPadding(false);scroll.addView(form);TextView validation=text("",13,RED,false);form.addView(validation);
        AlertDialog.Builder builder=dialogBuilder().setTitle(title).setView(scroll).setNegativeButton("取消",null).setPositiveButton("保存",null);if(remove!=null)builder.setNeutralButton("删除",null);
        AlertDialog dialog=builder.create();dialog.setOnShowListener(d->{MobileStyle.styleDialog(dialog);dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{try{if(store.isSyncing())throw new Exception("正在同步，请完成后再保存");save.run();dialog.dismiss();render();toast("已保存，下次扫码会同步到电脑");}catch(Exception e){validation.setText(e.getMessage()==null?"请核对填写内容":e.getMessage());scroll.post(()->scroll.smoothScrollTo(0,form.getBottom()));}});
            if(remove!=null)dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v->dialogBuilder().setTitle("确认删除？").setMessage(deleteMessage).setNegativeButton("取消",null).setPositiveButton("删除",(confirm,w)->{try{remove.run();dialog.dismiss();render();toast("已删除，变更将在下次扫码同步");}catch(Exception e){validation.setText(e.getMessage());scroll.post(()->scroll.smoothScrollTo(0,form.getBottom()));}}).show());});dialog.show();
    }
    private EditText dateField(LinearLayout form,String name,String value,boolean future){EditText input=field(form,name,value,InputType.TYPE_CLASS_DATETIME);input.setFocusable(false);input.setOnClickListener(v->{Calendar initial=Calendar.getInstance();String raw=input.getText().toString();if(!MobileLedger.isValidDate(raw))raw=LedgerStore.today();initial.set(Integer.parseInt(raw.substring(0,4)),Integer.parseInt(raw.substring(5,7))-1,Integer.parseInt(raw.substring(8,10)));
        DatePickerDialog picker=new DatePickerDialog(this,(view,year,month,day)->input.setText(String.format(Locale.US,"%04d-%02d-%02d",year,month+1,day)),initial.get(Calendar.YEAR),initial.get(Calendar.MONTH),initial.get(Calendar.DAY_OF_MONTH));if(!future){String today=LedgerStore.today();Calendar latest=Calendar.getInstance();latest.set(Integer.parseInt(today.substring(0,4)),Integer.parseInt(today.substring(5,7))-1,Integer.parseInt(today.substring(8,10)),23,59,59);picker.getDatePicker().setMaxDate(latest.getTimeInMillis());}picker.show();});return input;}
    private void showField(EditText field,boolean shown){field.setVisibility(shown?View.VISIBLE:View.GONE);ViewGroup parent=(ViewGroup)field.getParent();int index=parent.indexOfChild(field);if(index>0)parent.getChildAt(index-1).setVisibility(shown?View.VISIBLE:View.GONE);}
    private void watch(EditText edit,Runnable update){edit.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){update.run();}public void afterTextChanged(Editable value){}});}
    private void editTransaction(JSONObject original,JSONObject pending,String initialType,String initialAccount)throws Exception {
        JSONObject state=store.snapshot().getJSONObject("state");if(store.isSyncing())throw new Exception("正在同步，请稍后再编辑");List<JSONObject> accounts=allAccounts(state);
        if(accounts.isEmpty())throw new Exception("请先在「资产」添加一个账户，再记录收支。待确认通知会保留。");if(initialType.equals("transfer")&&accounts.size()<2)throw new Exception("账户转账需要至少两个账户，请先添加转入账户。");
        LinearLayout form=form();if(pending!=null){form.addView(text(pending.optString("reason"),14,RED,true));form.addView(label("通知摘要：\n"+pending.optString("snippet")));String details=captureDetails(original);if(!details.isEmpty())form.addView(label(details));form.addView(label("请核对实际付款账户；退款选择收入，账户间划转选择转账。"));}
        String[] types={"expense","income","transfer"};Spinner type=spinner(Arrays.asList("支出","收入","账户转账"));type.setSelection(Math.max(0,Arrays.asList(types).indexOf(initialType)));form.addView(type);
        List<String> names=new ArrayList<>();names.add("请选择实际收付款账户");int chosen=0,targetChosen=0;for(int i=0;i<accounts.size();i++){JSONObject account=accounts.get(i);names.add(accountName(account));if(account.optString("id").equals(initialAccount))chosen=i+1;if(original!=null&&account.optString("id").equals(original.optString("toAccountId")))targetChosen=i+1;}
        if(chosen==0&&accounts.size()==1&&pending==null)chosen=1;form.addView(label("收付款 / 转出账户"));Spinner account=spinner(names);account.setSelection(chosen);form.addView(account);
        TextView currencyHint=label("");form.addView(currencyHint);String initialCurrency=original==null?"CNY":original.optString("currency","CNY");
        EditText amount=field(form,"金额",original==null||pending!=null&&original.optLong("amount")<=0?"":amountInput(original.optLong("amount"),initialCurrency),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);
        TextView targetLabel=label("转入账户");form.addView(targetLabel);Spinner target=spinner(names);target.setSelection(targetChosen);form.addView(target);
        EditText targetAmount=field(form,"跨币种实际到账金额",original!=null&&original.has("toAmount")?amountInput(original.optLong("toAmount"),original.optString("toCurrency","CNY")):"",InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);
        EditText rate=field(form,"本笔历史汇率 · 1 原币折合人民币",original==null?"":original.optString("cnyRate"),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);
        EditText title=field(form,"账单名称",original==null?(initialType.equals("transfer")?"账户转账":""):original.optString("title"),InputType.TYPE_CLASS_TEXT);
        EditText category=field(form,"分类",original==null?(initialType.equals("income")?"其他收入":"其他支出"):original.optString("category"),InputType.TYPE_CLASS_TEXT);
        addButton(form,"选择常用分类",false,()->{String[] options=type.getSelectedItemPosition()==1?new String[]{"工资薪资","副业收入","投资收益","红包礼金","退款报销","其他收入"}:new String[]{"餐饮美食","购物消费","交通出行","居住生活","会员订阅","娱乐休闲","学习成长","医疗健康","人情往来","其他支出"};dialogBuilder().setTitle("分类").setItems(options,(d,index)->category.setText(options[index])).show();});
        EditText date=dateField(form,"账单日期",original==null?LedgerStore.today():original.optString("date"),false),note=field(form,"备注",original==null?"":original.optString("note"),InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);note.setMaxLines(5);
        JSONObject balances=MobileLedger.balances(state,LedgerStore.today());String[] previousAccount={""};
        Runnable update=()->{try{int index=account.getSelectedItemPosition(),targetIndex=target.getSelectedItemPosition();boolean transfer=type.getSelectedItemPosition()==2;target.setVisibility(transfer?View.VISIBLE:View.GONE);targetLabel.setVisibility(transfer?View.VISIBLE:View.GONE);category.setEnabled(!transfer);
            String code=index>0?accounts.get(index-1).optString("currency","CNY"):"CNY";String targetCode=targetIndex>0?accounts.get(targetIndex-1).optString("currency","CNY"):"CNY";showField(targetAmount,transfer&&targetIndex>0&&!code.equals(targetCode));showField(rate,!code.equals("CNY"));
            if(index>0){JSONObject selected=accounts.get(index-1);currencyHint.setText("币种 "+code+" · 当前余额 "+money(balances.optLong(selected.optString("id")),code));amount.setHint(code+" · 最多 "+MobileLedger.decimals(code)+" 位小数");targetAmount.setHint(targetCode+" 的实际到账金额");
                if(!previousAccount[0].equals(selected.optString("id"))){String value=original!=null&&original.optString("accountId").equals(selected.optString("id"))?original.optString("cnyRate",selected.optString("cnyRate")):selected.optString("cnyRate");rate.setText(value);previousAccount[0]=selected.optString("id");}}else currencyHint.setText("选择账户后，按账户币种填写金额");
        }catch(Exception ignored){currencyHint.setText("请检查账户币种与汇率");}};
        selected(type,position->{String current=category.getText().toString();if(current.equals("其他收入")||current.equals("其他支出")||current.equals("账户转账"))category.setText(position==1?"其他收入":position==2?"账户转账":"其他支出");update.run();});selected(account,position->update.run());selected(target,position->update.run());update.run();
        formDialog(pending!=null?"核对付款通知":original==null?"记一笔":"编辑账单",form,()->{
            int selected=account.getSelectedItemPosition();if(selected<=0)throw new Exception("请选择实际收付款账户");JSONObject sourceAccount=accounts.get(selected-1);String code=sourceAccount.optString("currency","CNY"),kind=types[type.getSelectedItemPosition()];
            JSONObject tx=original==null?new JSONObject().put("id","mob_"+UUID.randomUUID()):LedgerStore.copy(original);
            tx.put("type",kind).put("currency",code).put("amount",positiveMoney(amount,code)).put("accountId",sourceAccount.getString("id")).put("title",requiredText(title,"账单名称",120)).put("category",kind.equals("transfer")?"账户转账":requiredText(category,"分类",50)).put("date",date.getText().toString()).put("note",note.getText().toString().trim());
            if(code.equals("CNY"))tx.remove("cnyRate");else tx.put("cnyRate",MobileLedger.normalizeRate(rate.getText().toString().trim()));
            if(kind.equals("transfer")){int targetIndex=target.getSelectedItemPosition();if(targetIndex<=0)throw new Exception("请选择转入账户");JSONObject destination=accounts.get(targetIndex-1);String destinationCode=destination.optString("currency","CNY");if(destination.getString("id").equals(sourceAccount.getString("id")))throw new Exception("转入和转出账户不能相同");tx.put("toAccountId",destination.getString("id")).put("toCurrency",destinationCode).put("toAmount",code.equals(destinationCode)?tx.getLong("amount"):positiveMoney(targetAmount,destinationCode));}
            else{tx.remove("toAccountId");tx.remove("toCurrency");tx.remove("toAmount");}
            if(tx.has("subscriptionId")&&(!kind.equals("expense")||!tx.getString("date").substring(0,7).equals(original.optString("date").substring(0,7))))throw new Exception("订阅账单需保留支出类型和原账期；请在订阅计划里调整以后账期");
            if(pending!=null)store.putTransaction(tx,pending.getString("id"));else store.saveManual(tx);
        },original!=null&&pending==null?()->store.deleteManual(original.getString("id")):null,"这笔账单会从手机删除，并在下次扫码时同步删除。两端同时修改时会先要求确认。");
    }
    private void editAccount(JSONObject original)throws Exception {
        JSONObject state=store.snapshot().getJSONObject("state");LinearLayout form=form();String[] provider={original==null?"":original.optString("providerId")},color={original==null?"#8476D9":original.optString("color","#8476D9")};
        boolean used=false;if(original!=null){for(JSONObject tx:sortedTransactions(state))if(original.optString("id").equals(tx.optString("accountId"))||original.optString("id").equals(tx.optString("toAccountId")))used=true;JSONArray subscriptions=items(state,"subscriptions");for(int i=0;i<subscriptions.length();i++)if(original.optString("id").equals(subscriptions.getJSONObject(i).optString("accountId")))used=true;}
        final boolean currencyLocked=used;String initialCode=original==null?"CNY":original.optString("currency","CNY");
        EditText name=field(form,"账户名称",original==null?"":original.optString("name"),InputType.TYPE_CLASS_TEXT);
        List<String> typeLabels=new ArrayList<>(Arrays.asList("数字钱包","银行卡","现金","虚拟卡","其他账户",AppleBalance.TYPE)),typeValues=new ArrayList<>(typeLabels);final int appleTypeIndex=5;int initialType=4;
        if(original!=null){String kind=original.optString("type");if(AppleBalance.isAppleBalance(original)){initialType=appleTypeIndex;typeValues.set(appleTypeIndex,kind);}else if(AppleBalance.TYPE.equals(kind)){initialType=typeLabels.size();typeLabels.add(kind+"（自定义类型）");typeValues.add(kind);}else{initialType=typeLabels.indexOf(kind);if(initialType<0){initialType=typeLabels.size();typeLabels.add(kind);typeValues.add(kind);}}}
        form.addView(label("账户类型"));Spinner type=spinner(typeLabels);type.setSelection(initialType);form.addView(type);
        final Runnable[] refresh={()->{}};
        addButton(form,"选择微信 / 支付宝 / Apple 余额等",false,()->{String[] labels=new String[BrandIcons.ACCOUNTS.length];for(int i=0;i<labels.length;i++)labels[i]=BrandIcons.ACCOUNTS[i][1];dialogBuilder().setTitle("快捷账户").setItems(labels,(d,index)->{String[] preset=BrandIcons.ACCOUNTS[index];provider[0]=preset[0];color[0]=preset[3];name.setText(preset[1]);type.setSelection(typeLabels.indexOf(preset[2]));refresh[0].run();}).show();});
        LinearLayout applePanel=column();applePanel.setPadding(dp(14),dp(12),dp(14),dp(12));applePanel.setBackground(MobileStyle.outlined(this,SOFT,LINE,14));form.addView(applePanel);
        applePanel.addView(text("Apple 账户 / 礼品卡余额",17,INK,true));applePanel.addView(label("按国家地区和 Apple 账号分别记账"));
        List<AppleBalance.Region> regions=new ArrayList<>();List<String> regionNames=new ArrayList<>();String initialRegion=AppleBalance.isAppleBalance(original)?original.optString("appleRegion"):"US";
        if(currencyLocked&&!AppleBalance.isAppleBalance(original)){initialRegion="OTHER";for(AppleBalance.Region region:AppleBalance.regions())if(initialCode.equals(region.currency)){initialRegion=region.id;break;}}
        int chosenRegion=0;for(AppleBalance.Region region:AppleBalance.regions()){if(currencyLocked&&region.currency!=null&&!initialCode.equals(region.currency))continue;if(region.id.equals(initialRegion))chosenRegion=regions.size();regions.add(region);regionNames.add(region.name+(region.currency==null?"":" · "+region.currency));}
        TextView regionCaption=label("国家或地区");applePanel.addView(regionCaption);Spinner region=spinner(regionNames);region.setId(View.generateViewId());regionCaption.setLabelFor(region.getId());region.setSelection(chosenRegion);applePanel.addView(region);
        if(!currencyLocked){LinearLayout first=row(),second=row();applePanel.addView(first);applePanel.addView(second);String[] quick={"US","JP","TR","CN"};for(int i=0;i<quick.length;i++){final String regionId=quick[i];Button choice=button(AppleBalance.region(regionId).name,false,()->{for(int j=0;j<regions.size();j++)if(regions.get(j).id.equals(regionId)){region.setSelection(j);refresh[0].run();break;}});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);p.setMargins(dp(3),dp(6),dp(3),0);(i<2?first:second).addView(choice,p);}}
        EditText appleAccount=field(applePanel,"关联 Apple 账号 · 可选",original==null?"":original.optString("appleAccount"),InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);appleAccount.setHint("Apple 账号邮箱或账号标注");appleAccount.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(160)});
        TextView regionHint=label("");applePanel.addView(regionHint);applePanel.addView(label("填写已充值到 Apple 账号的实际余额。不同地区分别建账；充值记为转入，订阅扣账可选择此账户。"));
        List<String> bankNames=new ArrayList<>();bankNames.add("未指定银行");int bankIndex=0;for(int i=0;i<BrandIcons.BANKS.length;i++){bankNames.add(BrandIcons.BANKS[i][1]);if(original!=null&&original.optString("bankId").equals(BrandIcons.BANKS[i][0]))bankIndex=i+1;}if(original!=null&&!original.optString("bankId").isEmpty()&&bankIndex==0){bankNames.add("保留现有银行 · "+original.optString("bankId"));bankIndex=bankNames.size()-1;}TextView bankCaption=label("银行品牌（银行卡可选）");form.addView(bankCaption);Spinner bank=spinner(bankNames);bank.setSelection(bankIndex);form.addView(bank);
        EditText tail=field(form,"卡片尾号（可选，仅 4 位）",original==null?"":original.optString("lastFour"),InputType.TYPE_CLASS_NUMBER);
        String[] codes=MobileLedger.currencyCodes();form.addView(label("账户币种"));Spinner currency=spinner(Arrays.asList(codes));currency.setSelection(Math.max(0,Arrays.asList(codes).indexOf(initialCode)));form.addView(currency);
        if(currencyLocked)form.addView(label("此账户已有账单或订阅，币种不可直接更改；可修改同币种地区和关联账号。"));
        EditText opening=field(form,"期初余额（不包含后续收支）",original==null?"":amountInput(original.optLong("openingBalance"),initialCode),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL|InputType.TYPE_NUMBER_FLAG_SIGNED);
        TextView openingCaption=(TextView)form.getChildAt(form.indexOfChild(opening)-1);TextView balanceHint=label("");form.addView(balanceHint);
        EditText rate=field(form,"1 原币折合人民币 · 最多 8 位小数",original==null?"":original.optString("cnyRate"),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);
        form.addView(label("新外币账户请填写已确认的汇率。已有自动汇率账户若不改汇率值，会继续跟随电脑同步的汇率；修改后转为手动汇率。"));
        final String[] lastCode={initialCode};final boolean[] refreshing={false};
        refresh[0]=()->{if(refreshing[0])return;refreshing[0]=true;try{
            boolean apple=type.getSelectedItemPosition()==appleTypeIndex;String kind=typeValues.get(type.getSelectedItemPosition());
            if(apple){if(!AppleBalance.PROVIDER_ID.equals(provider[0]))color[0]=AppleBalance.COLOR;provider[0]=AppleBalance.PROVIDER_ID;if(name.getText().toString().trim().isEmpty())name.setText("Apple 余额");}else if(AppleBalance.PROVIDER_ID.equals(provider[0]))provider[0]="";
            applePanel.setVisibility(apple?View.VISIBLE:View.GONE);boolean card=!apple&&kind.contains("卡");bankCaption.setVisibility(card?View.VISIBLE:View.GONE);bank.setVisibility(card?View.VISIBLE:View.GONE);showField(tail,card);
            AppleBalance.Region selectedRegion=regions.get(region.getSelectedItemPosition());String desired=apple&&selectedRegion.currency!=null?selectedRegion.currency:codes[currency.getSelectedItemPosition()];
            if(currencyLocked)desired=initialCode;int codeIndex=Arrays.asList(codes).indexOf(desired);if(currency.getSelectedItemPosition()!=codeIndex)currency.setSelection(codeIndex);
            currency.setEnabled(!currencyLocked&&(!apple||selectedRegion.currency==null));
            if(!desired.equals(lastCode[0])){opening.setText("");rate.setText("");lastCode[0]=desired;balanceHint.setText("币种已切换，请重新填写 "+desired+" 余额和折算汇率。");}else balanceHint.setText(apple?"记录已兑换的 Apple 余额，不会自动查询或充值。":"期初余额不包含后续收支；充值可使用账户间转账。");
            regionHint.setText(selectedRegion.currency==null?"选择实际使用的币种，再填写该地区的余额。":"此地区使用 "+selectedRegion.currency+"。切换到不同币种时需重新填写金额。");
            openingCaption.setText((apple?"Apple 余额":"账户余额")+" · "+desired+(original==null?"":"（期初，不含后续收支）"));opening.setHint(desired+" 实际金额");showField(rate,!desired.equals("CNY"));
        }finally{refreshing[0]=false;}};
        selected(type,index->refresh[0].run());selected(region,index->refresh[0].run());selected(currency,index->refresh[0].run());refresh[0].run();
        formDialog(original==null?"添加账户":"管理账户",form,()->{
            String code=codes[currency.getSelectedItemPosition()],kind=typeValues.get(type.getSelectedItemPosition());JSONObject account=original==null?new JSONObject().put("id","acc_"+UUID.randomUUID()):LedgerStore.copy(original);
            account.put("name",requiredText(name,"账户名称",60)).put("type",kind).put("currency",code).put("color",color[0]).put("openingBalance",MobileLedger.parseMoney(opening.getText().toString().trim(),code));
            boolean matching=original!=null&&!provider[0].isEmpty()&&provider[0].equals(original.optString("providerId"))&&kind.equals(original.optString("type"));for(String[] preset:BrandIcons.ACCOUNTS)if(preset[0].equals(provider[0])&&preset[2].equals(kind))matching=true;if(matching)account.put("providerId",provider[0]);else account.put("providerId",JSONObject.NULL);
            if(AppleBalance.isAppleBalance(account)){account.put("appleRegion",regions.get(region.getSelectedItemPosition()).id);String linked=appleAccount.getText().toString().trim();account.put("appleAccount",linked.isEmpty()?JSONObject.NULL:linked);}else{account.put("appleRegion",JSONObject.NULL);account.put("appleAccount",JSONObject.NULL);}
            if(!AppleBalance.isAppleBalance(account)&&(kind.contains("卡")||original!=null&&kind.equals(original.optString("type"))&&!original.optString("bankId").isEmpty())){if(bank.getSelectedItemPosition()>0&&bank.getSelectedItemPosition()<=BrandIcons.BANKS.length){String[] b=BrandIcons.BANKS[bank.getSelectedItemPosition()-1];account.put("bankId",b[0]).put("color",b[2]);}else if(bank.getSelectedItemPosition()>BrandIcons.BANKS.length&&original!=null)account.put("bankId",original.getString("bankId"));else account.put("bankId",JSONObject.NULL);String last=tail.getText().toString().trim();if(!last.isEmpty()&&!last.matches("[0-9]{4}"))throw new Exception("卡片尾号请填写 4 位数字");if(last.isEmpty())account.put("lastFour",JSONObject.NULL);else account.put("lastFour",last);}else{account.put("bankId",JSONObject.NULL);account.put("lastFour",JSONObject.NULL);}
            if(code.equals("CNY")){account.remove("cnyRate");account.remove("rateMode");account.put("rateAsOf",JSONObject.NULL);account.put("rateSource",JSONObject.NULL);}else{String normalized=MobileLedger.normalizeRate(rate.getText().toString().trim());boolean unchanged=original!=null&&code.equals(initialCode)&&normalized.equals(original.optString("cnyRate"))&&original.optString("rateMode").equals("auto");account.put("cnyRate",normalized).put("rateMode",unchanged?"auto":"manual");if(!unchanged){account.put("rateAsOf",JSONObject.NULL);account.put("rateSource",JSONObject.NULL);}}
            store.saveAccount(account);
        },original==null?null:()->store.deleteAccount(original.getString("id")),"只有没有关联账单和订阅的账户才可删除。删除会在下次扫码时同步。");
    }
    private void renderSubscriptions(JSONObject data)throws Exception {
        JSONObject state=data.getJSONObject("state");JSONArray subscriptions=items(state,"subscriptions");heading("会员与订阅","到期自动记入账本，只记账，不会实际扣款或取消平台会员。");
        LinearLayout intro=card();long monthly=0;for(int i=0;i<subscriptions.length();i++){JSONObject sub=subscriptions.getJSONObject(i),account=findAccount(state,sub.optString("accountId"));if(sub.optBoolean("active")&&sub.optBoolean("recurring")&&account!=null)monthly+=MobileLedger.toCnyCents(sub.optLong("amount"),sub.optString("currency","CNY"),account.optString("currency","CNY").equals("CNY")?"1":account.optString("cnyRate"));}
        intro.setBackground(MobileStyle.heroSurface(this));intro.addView(label("每月启用的计划扣账 · 折合人民币"));intro.addView(amountText(money(monthly,"CNY"),31,INK));addButton(intro,"＋ 添加订阅",true,()->editSubscription(null));
        intro.addView(label("到期标注：已过期红色，7 天内橙色，8–30 天黄色，30 天以上绿色，未设置灰色。"));
        if(subscriptions.length()==0)intro.addView(label("选择服务品牌，填写你实际支付的金额和扣款账户。"));
        LinearLayout switcher=row();
        Button chartButton=button("订阅星图",subscriptionChart,()->selectSubscriptionView(true)),listButton=button("列表",!subscriptionChart,()->selectSubscriptionView(false));
        chartButton.setSelected(subscriptionChart);listButton.setSelected(!subscriptionChart);
        chartButton.setContentDescription("订阅星图"+(subscriptionChart?"，已选择":""));listButton.setContentDescription("订阅列表"+(!subscriptionChart?"，已选择":""));
        LinearLayout.LayoutParams chartParams=new LinearLayout.LayoutParams(0,-2,1),listParams=new LinearLayout.LayoutParams(0,-2,1);chartParams.rightMargin=dp(5);listParams.leftMargin=dp(5);
        switcher.addView(chartButton,chartParams);switcher.addView(listButton,listParams);gap(intro,10);intro.addView(switcher);
        if(subscriptionChart){renderSubscriptionChart(state);return;}
        JSONObject accountBalances=MobileLedger.balances(state,LedgerStore.today());
        for(int i=0;i<subscriptions.length();i++){final JSONObject sub=subscriptions.getJSONObject(i);LinearLayout c=card(),r=row();c.setBackground(MobileStyle.material(this,safeColor(sub.optString("color","#8C7BC1")),22));addLogo(r,BrandIcons.forSubscription(sub),sub.optString("name"),sub.optString("color","#8476D9"),44);LinearLayout labels=column();labels.addView(text(sub.optString("name"),17,INK,true));labels.addView(text(sub.optString("tier").isEmpty()?"自定义档位":sub.optString("tier"),12,MUTED,false));r.addView(labels,new LinearLayout.LayoutParams(0,-2,1));c.addView(r);gap(c,16);c.addView(amountText(money(sub.optLong("amount"),sub.optString("currency","CNY")),29,INK));String due=MobileLedger.nextSubscriptionDue(sub,LedgerStore.today());java.time.ZonedDateTime now=MobileLedger.beijingDateTime(System.currentTimeMillis());String today=now.toLocalDate().toString();boolean waiting=due!=null&&(due.compareTo(today)<0||due.equals(today)&&MobileLedger.subscriptionDueHour(sub,due)<=now.getHour());c.addView(label((sub.optBoolean("active")?(sub.optBoolean("recurring")?"每月 "+sub.optInt("billingDay")+" 日 "+String.format(Locale.US,"%02d:00",sub.optInt("billingHour",0)):"单次记账"):"已暂停")+(due==null?"":(waiting?" · 待扣账 ":" · 下次 ")+due+" "+String.format(Locale.US,"%02d:00",MobileLedger.subscriptionDueHour(sub,due))+" 北京时间")));
            SubscriptionDetails.Status expiry=SubscriptionDetails.expiryStatus(sub,LedgerStore.today());int tone=expiryColor(expiry.tone);TextView badge=text(expiry.label,13,tone,true);badge.setPadding(dp(11),dp(9),dp(11),dp(9));badge.setBackground(MobileStyle.outlined(this,MobileStyle.blend(Color.WHITE,tone,.06f),MobileStyle.blend(Color.WHITE,tone,.22f),11));c.addView(badge);gap(c,5);c.addView(text(expiry.detail,12,MUTED,false));
            gap(c,12);c.addView(subscriptionFunding(findAccount(state,sub.optString("accountId")),accountBalances.optLong(sub.optString("accountId")),sub.optLong("amount"),waiting));
            JSONArray linked=sub.optJSONArray("linkedAccounts");if(linked!=null&&linked.length()>0){gap(c,12);c.addView(text("关联登录账号",13,MUTED,true));for(int j=0;j<linked.length();j++){JSONObject identity=linked.getJSONObject(j);c.addView(text(linkedAccountLabel(identity),12,INK,false));}}
            if(!sub.optString("note").isEmpty())c.addView(label(sub.optString("note")));
            actionPair(c,"编辑计划",()->editSubscription(sub),sub.optBoolean("active")?"暂停记账":"恢复记账",()->{JSONObject changed=LedgerStore.copy(sub).put("active",!sub.optBoolean("active"));store.saveSubscription(changed);render();});
        }
    }
    private void selectSubscriptionView(boolean chart){subscriptionChart=chart;getPreferences(MODE_PRIVATE).edit().putBoolean("subscriptionChart",chart).apply();render();}
    private LinearLayout subscriptionStat(String title,int count,int tint){
        LinearLayout item=column();item.setPadding(dp(13),dp(12),dp(13),dp(13));item.setBackground(MobileStyle.material(this,tint,15));
        item.addView(text(title,12,MUTED,false));item.addView(text(count+" 项",25,tint,true));return item;
    }
    private void renderSubscriptionChart(JSONObject state)throws Exception {
        JSONObject overview=SubscriptionOverview.build(state,System.currentTimeMillis()),stats=overview.getJSONObject("stats");
        JSONArray rows=overview.getJSONArray("rows"),accounts=overview.getJSONArray("accounts");
        LinearLayout summary=card();
        String[] titles={"30 天内","7 天内","待扣账","余额不足"},keys={"upcoming","urgent","pending","shortfall"};
        int[] colors={PURPLE,0xFFC67950,0xFF637FB4,RED};
        for(int line=0;line<2;line++){
            LinearLayout pair=row();
            for(int column=0;column<2;column++){
                int index=line*2+column;LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);if(column==0)params.rightMargin=dp(5);else params.leftMargin=dp(5);
                pair.addView(subscriptionStat(titles[index],stats.getInt(keys[index]),colors[index]),params);
            }
            if(line>0)gap(summary,10);summary.addView(pair);
        }
        summary.addView(label("提醒可同时出现；余额不足按每项下一笔费用单独比较。"));
        LinearLayout radarCard=card();radarCard.setBackground(MobileStyle.heroSurface(this));sectionTitle(radarCard,"订阅星图","spark");
        radarCard.addView(label("越接近中心，会员期限或续费日期越临近。"));
        SubscriptionRadarView radar=new SubscriptionRadarView(this,overview);radarCard.addView(radar,new LinearLayout.LayoutParams(-1,-2));
        radarCard.addView(text(radar.plottedSummary(),11,MUTED,false));radarCard.addView(label(radar.outsideSummary()));

        LinearLayout alerts=card();sectionTitle(alerts,"需要留意","bell");int alertCount=0;
        for(int i=0;i<rows.length();i++){
            JSONObject row=rows.getJSONObject(i),expiry=row.getJSONObject("expiry");
            boolean near=!expiry.isNull("days")&&expiry.getLong("days")<=7;
            if(row.getBoolean("pending")||row.getLong("shortfall")>0||near){subscriptionOverviewRow(alerts,row,true);alertCount++;}
        }
        if(alertCount==0)alerts.addView(label("当前没有待扣账、临近日期或单笔余额不足的提醒。"));

        LinearLayout preparation=card();sectionTitle(preparation,"续费准备","wallet");
        preparation.addView(label("每项启用计划仅计下一笔，包含逾期待扣。按账户原币准备资金，非 30 天费用预测。"));
        if(accounts.length()==0)preparation.addView(label("暂无需要准备的下一笔费用。"));
        for(int i=0;i<accounts.length();i++){
            JSONObject group=accounts.getJSONObject(i),account=group.getJSONObject("account");String currency=group.getString("currency");
            long required=group.getLong("amount"),balance=group.getLong("balance"),gap=group.getLong("shortfall");
            LinearLayout funding=column();funding.setPadding(dp(14),dp(13),dp(14),dp(13));funding.setBackground(MobileStyle.material(this,gap>0?RED:GREEN,16));
            LinearLayout identity=row();addLogo(identity,BrandIcons.forAccount(account),account.optString("name"),account.optString("color","#8476D9"),32);
            identity.addView(text(accountName(account),14,INK,true),new LinearLayout.LayoutParams(0,-2,1));funding.addView(identity);
            funding.addView(label("当前余额  "+fundingDifference(balance,currency)));funding.addView(text("下一笔合计  "+fundingDifference(required,currency),15,INK,true));
            progress(funding,Math.max(0,balance),required,gap>0?RED:GREEN);
            funding.addView(text("覆盖 "+Math.round(group.getDouble("coverage")*100)+"% · "+group.getJSONArray("subscriptions").length()+" 项计划",12,MUTED,false));
            funding.addView(text(gap>0?"还需准备  "+fundingDifference(gap,currency):"下一笔合计费用已覆盖",13,gap>0?RED:GREEN,true));
            funding.addView(text("最早扣账 "+group.getString("due")+" "+String.format(Locale.US,"%02d:00",group.getInt("dueHour"))+" · 北京时间",11,MUTED,false));
            LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(10);preparation.addView(funding,params);
        }
        LinearLayout services=card();sectionTitle(services,"服务清单 · "+rows.length()+" 项","repeat");services.addView(label("点按任一服务查看或编辑，期限与扣账计划分别展示。"));
        for(int i=0;i<rows.length();i++)subscriptionOverviewRow(services,rows.getJSONObject(i),false);
        if(rows.length()==0)addButton(services,"＋ 添加第一项订阅",true,()->editSubscription(null));
    }
    private void subscriptionOverviewRow(LinearLayout parent,JSONObject row,boolean alert)throws Exception {
        JSONObject sub=row.getJSONObject("sub"),expiry=row.getJSONObject("expiry");List<String> flags=new ArrayList<>();
        if(!sub.getBoolean("active"))flags.add("已暂停");
        if(row.getBoolean("pending"))flags.add("待扣账");
        if(!expiry.isNull("days")){
            long days=expiry.getLong("days");String source=expiry.getString("source");
            if(days<0)flags.add(source.equals("expiry")?"会员已到期":"扣账已逾期");
            else if(days<=7)flags.add(source.equals("expiry")?"7天内到期":"7天内续费");
        }
        if(row.getLong("shortfall")>0)flags.add("余额不足");
        if(flags.isEmpty())flags.add(row.getBoolean("canBook")?"已安排":sub.getBoolean("active")?"当前计划已完成":"已暂停");
        boolean urgent=row.getBoolean("pending")||row.getLong("shortfall")>0||!expiry.isNull("days")&&expiry.getLong("days")<0;
        LinearLayout item=column();item.setPadding(dp(13),dp(12),dp(13),dp(12));item.setBackground(MobileStyle.cardRipple(this,alert&&urgent?RED:PURPLE,15));item.setMinimumHeight(dp(64));
        LinearLayout identity=row();addLogo(identity,BrandIcons.forSubscription(sub),sub.getString("name"),sub.optString("color","#8476D9"),32);
        identity.addView(text(sub.getString("name"),15,INK,true),new LinearLayout.LayoutParams(0,-2,1));identity.addView(text("编辑 ›",11,PURPLE,true));item.addView(identity);
        String status=String.join(" · ",flags);item.addView(text(status,12,urgent?RED:PURPLE,true));
        String fee=fundingDifference(sub.getLong("amount"),row.getString("currency"))+(sub.getBoolean("recurring")?" / 月":" / 次");item.addView(text(fee,14,INK,true));
        String deadline=expiry.isNull("date")?"会员期限未设置":(expiry.getString("source").equals("expiry")?"会员期限 ":"续费提醒 ")+expiry.getString("date");item.addView(text(deadline,11,MUTED,false));
        String due;
        if(row.getBoolean("canBook"))due=(row.getBoolean("pending")?"待扣账期 ":"下一次扣账 ")+row.getString("due")+" "+String.format(Locale.US,"%02d:00",row.getInt("dueHour"))+" · 北京时间";
        else due=sub.getBoolean("active")?"当前计划已处理完毕":"自动记账已暂停";
        item.addView(text(due,11,MUTED,false));
        item.setContentDescription(sub.getString("name")+"，"+status+"，"+fee+"，"+deadline+"，"+due+"，点按编辑");item.setFocusable(true);item.setOnClickListener(view->act(()->editSubscription(sub)));
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(9);parent.addView(item,params);
    }
    /** Read-only comparison, in integer units of the selected account; no booking or currency conversion. */
    private LinearLayout subscriptionFunding(JSONObject account,long balance,Long fee){
        return subscriptionFunding(account,balance,fee,false);
    }
    private LinearLayout subscriptionFunding(JSONObject account,long balance,Long fee,boolean pending){
        LinearLayout panel=column();panel.setPadding(dp(15),dp(14),dp(15),dp(14));panel.setBackground(MobileStyle.material(this,0xFF93A3C3,16));
        panel.addView(text("扣款账户",12,MUTED,true));panel.addView(text(accountName(account),14,INK,true));gap(panel,8);
        String code=account==null?"CNY":account.optString("currency","CNY");panel.addView(text("当前账本余额",12,MUTED,false));panel.addView(amountText(money(balance,code),24,INK));
        if(fee!=null&&fee>0){panel.addView(text("本次费用  "+money(fee,code),14,INK,false));long difference=fee-balance;if(difference>0)panel.setBackground(MobileStyle.material(this,RED,16));TextView status=text(difference>0?(pending?"余额不足，待补款 · 还差 ":"余额不足 · 还差 ")+fundingDifference(difference,code):"余额充足",13,difference>0?RED:GREEN,true);gap(panel,8);panel.addView(status);if(pending&&difference>0)panel.addView(text("本期尚未扣账，补足后自动处理。",12,RED,false));}
        else panel.addView(label("填写本次费用后，可查看余额是否足够。"));
        panel.addView(text("按当前余额比较一笔费用。余额不足时暂缓扣账，补足后自动处理。",11,MUTED,false));return panel;
    }
    private String fundingDifference(long units,String currency){try{int precision=MobileLedger.decimals(currency);BigDecimal value=BigDecimal.valueOf(units,precision);String raw=(currency.equals("USDT")?value.stripTrailingZeros():value).toPlainString();String[] parts=raw.split("\\.");parts[0]=parts[0].replaceAll("(?<=\\d)(?=(\\d{3})+$)",",");return (currency.equals("CNY")?"¥":currency)+" "+parts[0]+(parts.length==2?"."+parts[1]:"");}catch(Exception invalid){return "金额待核对";}}
    private int expiryColor(String tone){return tone.equals("expired")?0xFFAE3652:tone.equals("urgent")?0xFFA04B12:tone.equals("soon")?0xFF83620D:tone.equals("normal")?GREEN:MUTED;}
    private String linkedAccountLabel(JSONObject account){String kind="其他";for(String[] type:SubscriptionDetails.TYPES)if(type[0].equals(account.optString("type")))kind=type[1];return kind+" · "+account.optString("value")+(account.optString("label").isEmpty()?"":"（"+account.optString("label")+"）");}
    private final class SubscriptionLinksEditor {
        final LinearLayout view=column(),rows=column();final List<LinkedRow> entries=new ArrayList<>();
        final class LinkedRow {final LinearLayout box=column();final Spinner type;final EditText value,caption;LinkedRow(JSONObject item){
            List<String> types=new ArrayList<>();int selected=0;for(int i=0;i<SubscriptionDetails.TYPES.length;i++){types.add(SubscriptionDetails.TYPES[i][1]);if(SubscriptionDetails.TYPES[i][0].equals(item.optString("type")))selected=i;}
            box.setPadding(dp(12),dp(10),dp(12),dp(10));box.setBackground(MobileStyle.outlined(MainActivity.this,SOFT,LINE,12));TextView title=label("账号类型");box.addView(title);type=spinner(types);type.setId(View.generateViewId());title.setLabelFor(type.getId());type.setSelection(selected);box.addView(type);
            value=field(box,"关联账号",item.optString("value"),InputType.TYPE_CLASS_TEXT);caption=field(box,"标注 · 可选",item.optString("label"),InputType.TYPE_CLASS_TEXT);value.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(160)});caption.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(40)});
            addButton(box,"移除此关联",false,()->{entries.remove(this);rows.removeView(box);});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(10);rows.addView(box,p);
        }}
        SubscriptionLinksEditor(JSONObject state,JSONObject original)throws Exception{
            view.addView(text("关联邮箱 / Apple 账号",16,INK,true));view.addView(label("可选择已有账号，也可添加邮箱、Apple、Google、手机号等，最多 10 项。"));view.addView(rows);
            JSONArray values=original==null?null:original.optJSONArray("linkedAccounts");if(values!=null)for(int i=0;i<values.length();i++)add(values.getJSONObject(i));
            addButton(view,"＋ 添加关联账号",false,()->add(new JSONObject().put("type","email")));
            addButton(view,"选择已有账号",false,()->{JSONArray saved=SubscriptionDetails.savedLinkedAccounts(state);if(saved.length()==0)throw new Exception("暂无已保存账号，可先添加关联账号，或填写 Apple 余额账户的账号。");String[] labels=new String[saved.length()];for(int i=0;i<labels.length;i++)labels[i]=linkedAccountLabel(saved.getJSONObject(i));dialogBuilder().setTitle("选择关联账号").setItems(labels,(d,index)->act(()->add(saved.getJSONObject(index)))).show();});
        }
        void add(JSONObject value)throws Exception{if(entries.size()>=10)throw new Exception("每项订阅最多关联 10 个账号");entries.add(new LinkedRow(value));}
        JSONArray read()throws Exception{JSONArray result=new JSONArray();for(LinkedRow entry:entries){String value=requiredText(entry.value,"关联账号",160),caption=entry.caption.getText().toString().trim();JSONObject linked=new JSONObject().put("type",SubscriptionDetails.TYPES[entry.type.getSelectedItemPosition()][0]).put("value",value);if(!caption.isEmpty())linked.put("label",caption);result.put(linked);}return result;}
    }
    private void editSubscription(JSONObject original)throws Exception {
        JSONObject state=store.snapshot().getJSONObject("state");List<JSONObject> accounts=allAccounts(state);if(accounts.isEmpty())throw new Exception("请先添加扣款账户，再添加订阅");LinearLayout form=form();String[] service={original==null?"":original.optString("serviceId")},color={original==null?"#8476D9":original.optString("color","#8476D9")};
        EditText name=field(form,"订阅名称",original==null?"":original.optString("name"),InputType.TYPE_CLASS_TEXT),tier=field(form,"档位（可自填）",original==null?"":original.optString("tier"),InputType.TYPE_CLASS_TEXT);
        addButton(form,"选择会员服务",false,()->{String[] labels=new String[BrandIcons.SERVICES.length+1];labels[0]="自定义服务";for(int i=0;i<BrandIcons.SERVICES.length;i++)labels[i+1]=BrandIcons.SERVICES[i][1];dialogBuilder().setTitle("会员服务").setItems(labels,(d,index)->{if(index==0){service[0]="";return;}String[] item=BrandIcons.SERVICES[index-1];service[0]=item[0];color[0]=item[2];name.setText(item[1]);tier.setText("");}).show();});
        addButton(form,"选择服务档位",false,()->{for(String[] preset:BrandIcons.SERVICES)if(preset[0].equals(service[0])){String[] tiers=preset[3].split("\\|");dialogBuilder().setTitle("档位仅作名称，请填写实付金额").setItems(tiers,(d,index)->tier.setText(tiers[index])).show();return;}throw new Exception("可直接填写自定义档位，或先选择会员服务");});
        List<String> names=new ArrayList<>();int selection=0;for(int i=0;i<accounts.size();i++){names.add(accountName(accounts.get(i)));if(original!=null&&original.optString("accountId").equals(accounts.get(i).optString("id")))selection=i;}form.addView(label("对应扣款账户"));Spinner account=spinner(names);account.setSelection(selection);form.addView(account);
        EditText amount=field(form,"每次实际扣账金额",original==null?"":amountInput(original.optLong("amount"),original.optString("currency","CNY")),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);TextView unit=label("");form.addView(unit);
        LinearLayout fundingPreview=column();form.addView(fundingPreview);
        Runnable refreshFunding=()->{try{JSONObject selected=accounts.get(account.getSelectedItemPosition());String code=selected.optString("currency","CNY");Long charge=null;try{long parsed=MobileLedger.parseMoney(amount.getText().toString().trim(),code);if(parsed>0)charge=parsed;}catch(Exception ignored){}JSONObject latest=store.snapshot().getJSONObject("state");JSONObject selectedLatest=findAccount(latest,selected.optString("id"));if(selectedLatest==null||!selectedLatest.optString("currency","CNY").equals(code))throw new Exception("扣款账户已变更，请重新打开编辑。");long balance=MobileLedger.balances(latest,LedgerStore.today()).getLong(selected.getString("id"));fundingPreview.removeAllViews();fundingPreview.addView(subscriptionFunding(selectedLatest,balance,charge));}catch(Exception invalid){fundingPreview.removeAllViews();fundingPreview.addView(label("余额暂不可用，请核对扣款账户。"));}};
        watch(amount,refreshFunding);
        form.addView(label("订阅扣账统一使用北京时间（UTC+8），精确到整点。"));
        EditText start=dateField(form,"首次扣账日期 · 北京时间",original==null?LedgerStore.today():original.optString("startDate"),true);
        List<String> hours=new ArrayList<>();for(int hour=0;hour<24;hour++)hours.add(String.format(Locale.US,"%02d:00",hour));
        form.addView(label("首次扣账时间 · 北京时间"));Spinner startHour=spinner(hours);startHour.setSelection(original==null?MobileLedger.beijingDateTime(System.currentTimeMillis()).getHour():original.optInt("startHour",0));form.addView(startHour);
        Switch monthlyOverride=new Switch(this);monthlyOverride.setText("单独设置每月扣账日和时间");
        monthlyOverride.setChecked(original!=null&&(original.optInt("billingDay")!=Integer.parseInt(start.getText().toString().substring(8))||original.optInt("billingHour",0)!=original.optInt("startHour",0)));form.addView(monthlyOverride);
        LinearLayout monthlySettings=column();
        EditText day=field(monthlySettings,"每月扣账日 · 1 至 31",original==null?LedgerStore.today().substring(8):String.valueOf(original.optInt("billingDay")),InputType.TYPE_CLASS_NUMBER);
        monthlySettings.addView(label("每月扣账时间 · 北京时间"));Spinner billingHour=spinner(hours);billingHour.setSelection(original==null?startHour.getSelectedItemPosition():original.optInt("billingHour",0));monthlySettings.addView(billingHour);form.addView(monthlySettings);
        TextView monthlySummary=label("");form.addView(monthlySummary);
        Switch recurring=new Switch(this);recurring.setText("连续订阅，每月记账");recurring.setChecked(original==null||original.optBoolean("recurring"));form.addView(recurring);Switch active=new Switch(this);active.setText("启用计划扣账");active.setChecked(original==null||original.optBoolean("active"));form.addView(active);
        form.addView(label("短月份使用当月最后一天。余额不足时先等待补款，补足后自动处理；暂停期间不补扣。自动记账只影响账本余额。"));
        EditText expires=dateField(form,"会员到期日期 · 可选",original==null?"":original.optString("expiresOn"),true);expires.setHint("选择会员到期日期");addButton(form,"清除到期日期",false,()->expires.setText(""));
        TextView expiryPreview=label("");form.addView(expiryPreview);form.addView(label("连续订阅每次成功记账后，会员到期日自动顺延一个月；未填写时显示下次续费日期。"));
        Runnable refreshExpiry=()->{try{JSONObject preview=original==null?new JSONObject().put("id","preview").put("processedOccurrences",new JSONArray()):LedgerStore.copy(original);preview.put("startDate",start.getText().toString()).put("billingDay",Integer.parseInt(day.getText().toString())).put("recurring",recurring.isChecked()).put("active",active.isChecked()).put("expiresOn",expires.getText().toString());if(original!=null&&(!original.optString("expiresOn").equals(preview.optString("expiresOn"))||original.optBoolean("recurring")!=preview.optBoolean("recurring")))preview=MobileLedger.resetSubscriptionExpiry(preview,state.getJSONArray("transactions"));SubscriptionDetails.validateSubscription(preview);SubscriptionDetails.Status status=SubscriptionDetails.expiryStatus(preview,LedgerStore.today());expiryPreview.setText(status.label+" · "+status.detail);expiryPreview.setTextColor(expiryColor(status.tone));}catch(Exception invalid){expiryPreview.setText(invalid.getMessage()==null?"请核对扣账日期和到期日期。":invalid.getMessage());expiryPreview.setTextColor(MUTED);}};
        Runnable updateSchedule=()->{
            boolean enabled=recurring.isChecked(),independent=monthlyOverride.isChecked();
            monthlyOverride.setVisibility(enabled?View.VISIBLE:View.GONE);monthlySettings.setVisibility(enabled&&independent?View.VISIBLE:View.GONE);monthlySummary.setVisibility(enabled&&!independent?View.VISIBLE:View.GONE);
            day.setEnabled(enabled);billingHour.setEnabled(enabled);
            String firstDate=start.getText().toString();
            if(!independent){
                if(MobileLedger.isValidDate(firstDate))day.setText(String.valueOf(Integer.parseInt(firstDate.substring(8))));
                billingHour.setSelection(startHour.getSelectedItemPosition());
            }
            if(MobileLedger.isValidDate(firstDate))monthlySummary.setText("每月同样在 "+Integer.parseInt(firstDate.substring(8))+" 日 "+hours.get(startHour.getSelectedItemPosition())+" 扣账（北京时间）。");
        };
        watch(expires,refreshExpiry);
        watch(start,()->{updateSchedule.run();refreshExpiry.run();});watch(day,refreshExpiry);
        selected(startHour,hour->{updateSchedule.run();refreshExpiry.run();});selected(billingHour,hour->refreshExpiry.run());
        monthlyOverride.setOnCheckedChangeListener((v,checked)->{updateSchedule.run();refreshExpiry.run();});
        recurring.setOnCheckedChangeListener((v,checked)->{updateSchedule.run();refreshExpiry.run();});active.setOnCheckedChangeListener((v,checked)->refreshExpiry.run());updateSchedule.run();refreshExpiry.run();
        SubscriptionLinksEditor identities=new SubscriptionLinksEditor(state,original);form.addView(identities.view);
        EditText note=field(form,"订阅备注 · 可选",original==null?"":original.optString("note"),InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);note.setMaxLines(4);note.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(500)});
        final String[] amountCurrency={original==null?accounts.get(selection).optString("currency","CNY"):original.optString("currency","CNY")};
        selected(account,index->{String code=accounts.get(index).optString("currency","CNY");if(!code.equals(amountCurrency[0])){amount.setText("");amountCurrency[0]=code;toast("扣款币种已变更，请重新填写 "+code+" 金额");}unit.setText("金额单位 "+code+" · "+accountName(accounts.get(index)));amount.setHint(code+" 实际扣账金额");refreshFunding.run();});unit.setText("金额单位 "+accounts.get(selection).optString("currency","CNY"));refreshFunding.run();
        formDialog(original==null?"添加订阅":"编辑订阅",form,()->{updateSchedule.run();JSONObject chosen=accounts.get(account.getSelectedItemPosition());String code=chosen.optString("currency","CNY");JSONObject sub=original==null?new JSONObject().put("id","sub_"+UUID.randomUUID()).put("processedOccurrences",new JSONArray()):LedgerStore.copy(original);
            JSONObject latestAccount=findAccount(store.snapshot().getJSONObject("state"),chosen.getString("id"));if(latestAccount==null||!code.equals(latestAccount.optString("currency","CNY")))throw new Exception("扣款账户已变更，请重新打开编辑后填写金额。");
            int billingDay;try{billingDay=Integer.parseInt(day.getText().toString().trim());}catch(Exception e){billingDay=0;}
            if(billingDay<1||billingDay>31){if(recurring.isChecked())throw new Exception("扣账日请填写 1 至 31 的整数");billingDay=Integer.parseInt(start.getText().toString().substring(8));}
            sub.put("name",requiredText(name,"订阅名称",80)).put("tier",tier.getText().toString().trim()).put("accountId",chosen.getString("id")).put("currency",code).put("amount",positiveMoney(amount,code)).put("category","会员订阅").put("startDate",start.getText().toString()).put("billingDay",billingDay).put("recurring",recurring.isChecked()).put("active",active.isChecked()).put("color",color[0]).put("icon",original==null?"repeat":original.optString("icon","repeat"));
            sub.put("startHour",startHour.getSelectedItemPosition()).put("billingHour",billingHour.getSelectedItemPosition());
            sub.put("linkedAccounts",identities.read()).put("expiresOn",expires.getText().toString()).put("note",note.getText().toString().trim());
            if(original!=null&&original.optString("expiresOn").equals(expires.getText().toString()))sub.remove("expiresOn");
            if(service[0].isEmpty())sub.put("serviceId",JSONObject.NULL);else sub.put("serviceId",service[0]);store.saveSubscription(sub);
        },original==null?null:()->store.deleteSubscription(original.getString("id")),"删除这个订阅计划会停止以后自动记账，历史账单会保留。不会取消平台会员。");
    }
    private void renderGoals(JSONObject data)throws Exception {heading("把心愿慢慢存起来","心愿进度用于规划，不改变任何账户的实际余额。");LinearLayout start=card();addButton(start,"＋ 添加储蓄心愿",true,()->editGoal(null));JSONArray goals=items(data.getJSONObject("state"),"goals");if(goals.length()==0)start.addView(label("给下一次旅行、新设备或备用金留一个位置。"));for(int i=0;i<goals.length();i++){final JSONObject goal=goals.getJSONObject(i);LinearLayout c=card();c.addView(text(goal.optString("name"),19,INK,true));c.addView(label("已存 "+money(goal.optLong("saved"),"CNY")+" / 目标 "+money(goal.optLong("target"),"CNY")));progress(c,goal.optLong("saved"),goal.optLong("target"),safeColor(goal.optString("color","#8476D9")));long remaining=Math.max(0,goal.optLong("target")-goal.optLong("saved"));c.addView(text(remaining==0?"心愿已达成":"还差 "+money(remaining,"CNY"),13,remaining==0?GREEN:MUTED,false));addButton(c,"更新进度 / 编辑",false,()->editGoal(goal));}}
    private void editGoal(JSONObject original)throws Exception {LinearLayout form=form();EditText name=field(form,"心愿名称",original==null?"":original.optString("name"),InputType.TYPE_CLASS_TEXT),target=field(form,"目标金额 · CNY",original==null?"":amountInput(original.optLong("target"),"CNY"),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL),saved=field(form,"已存金额 · CNY",original==null?"0":amountInput(original.optLong("saved"),"CNY"),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);form.addView(label("记录规划进度，不会从账户扣款或转移资产。"));formDialog(original==null?"添加心愿":"编辑心愿",form,()->{JSONObject goal=original==null?new JSONObject().put("id","goal_"+UUID.randomUUID()).put("color","#8476D9"):LedgerStore.copy(original);goal.put("name",requiredText(name,"心愿名称",80)).put("target",positiveMoney(target,"CNY")).put("saved",nonNegativeMoney(saved,"CNY"));store.saveGoal(goal);},original==null?null:()->store.deleteGoal(original.getString("id")),"删除心愿不会改变账户余额。");}
    private void renderBudget(JSONObject data)throws Exception {
        JSONObject state=data.getJSONObject("state");String month=LedgerStore.today().substring(0,7);JSONObject summary=MobileLedger.monthlySummary(state,month,LedgerStore.today());heading("本月预算",month+" · 所有币种按账单历史汇率折合人民币");LinearLayout c=card();c.addView(text(money(summary.optLong("expense"),"CNY"),31,INK,true));c.addView(label("本月已支出"));long budget=summary.optLong("budget");if(budget>0){progress(c,summary.optLong("expense"),budget,summary.optLong("remaining")<0?RED:PURPLE);c.addView(label("预算 "+money(budget,"CNY")+" · "+(summary.optLong("remaining")>=0?"剩余 ":"超出 ")+money(Math.abs(summary.optLong("remaining")),"CNY")));}else c.addView(label("尚未设置月度预算"));addButton(c,"设置月度预算",true,this::editBudget);
        Map<String,Long> totals=new LinkedHashMap<>();for(JSONObject tx:sortedTransactions(state))if(tx.optString("type").equals("expense")&&tx.optString("date").startsWith(month)&&tx.optString("date").compareTo(LedgerStore.today())<=0){String category=tx.optString("category");totals.put(category,totals.getOrDefault(category,0L)+MobileLedger.transactionCnyAmount(tx));}
        LinearLayout categories=card();categories.addView(text("支出分类",18,INK,true));List<Map.Entry<String,Long>> sorted=new ArrayList<>(totals.entrySet());Collections.sort(sorted,(a,b)->Long.compare(b.getValue(),a.getValue()));if(sorted.isEmpty())categories.addView(label("本月还没有支出"));for(Map.Entry<String,Long> entry:sorted){LinearLayout r=row();r.setPadding(0,dp(12),0,0);r.addView(text(entry.getKey(),14,INK,false),new LinearLayout.LayoutParams(0,-2,1));r.addView(text(money(entry.getValue(),"CNY"),14,INK,true));categories.addView(r);progress(categories,entry.getValue(),summary.optLong("expense"),PURPLE);}
    }
    private void editBudget()throws Exception {JSONObject current=store.snapshot().getJSONObject("state").getJSONObject("settings");LinearLayout form=form();EditText amount=field(form,"每月预算 · 人民币",amountInput(current.optLong("monthlyBudget"),"CNY"),InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);form.addView(label("填写 0 表示不设预算。只统计收入/支出，账户转账不计入花销。"));formDialog("月度预算",form,()->store.saveSettings(LedgerStore.copy(current).put("monthlyBudget",nonNegativeMoney(amount,"CNY")).put("currency","CNY")),null,"");}
    private void exportCsv()throws Exception {if(store.isSyncing())throw new Exception("请完成同步后再导出");Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/csv").putExtra(Intent.EXTRA_TITLE,"超级账本-账单-"+(selectedMonth.isEmpty()?"全部":selectedMonth)+".csv");startActivityForResult(intent,45);}
    private static String csvCell(String value){String safe=value==null?"":value;if(safe.matches("(?s)^\\s*[=+@-].*"))safe="'"+safe;return "\""+safe.replace("\"","\"\"")+"\"";}
    private String csvText(JSONObject state)throws Exception {StringBuilder text=new StringBuilder("\uFEFF日期,类型,名称,分类,账户,币种,原币金额,转入账户,到账币种,到账金额,人民币参考金额,备注\r\n");for(JSONObject tx:filteredTransactions(state)){String kind=tx.optString("type"),currency=tx.optString("currency","CNY");String[] values={tx.optString("date"),kind.equals("income")?"收入":kind.equals("expense")?"支出":"转账",tx.optString("title"),tx.optString("category"),accountName(findAccount(state,tx.optString("accountId"))),currency,amountInput(tx.optLong("amount"),currency),kind.equals("transfer")?accountName(findAccount(state,tx.optString("toAccountId"))):"",kind.equals("transfer")?tx.optString("toCurrency","CNY"):"",kind.equals("transfer")?amountInput(tx.has("toAmount")?tx.optLong("toAmount"):tx.optLong("amount"),tx.optString("toCurrency","CNY")):"",amountInput(MobileLedger.transactionCnyAmount(tx),"CNY"),tx.optString("note")};for(int i=0;i<values.length;i++){if(i>0)text.append(',');text.append(csvCell(values[i]));}text.append("\r\n");}return text.toString();}
    private void importBackup()throws Exception {if(store.isSyncing())throw new Exception("请完成同步后再恢复备份");startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json"),46);}
    private void readBackup(Uri uri){toast("正在读取备份…");new Thread(()->{try{ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream input=getContentResolver().openInputStream(uri)){if(input==null)throw new Exception("无法读取所选备份");byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))>=0){if(bytes.size()+count>16*1024*1024)throw new Exception("手机备份不能超过 16 MB");bytes.write(buffer,0,count);}}JSONObject backup=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8).replaceFirst("^\\uFEFF",""));JSONObject state=backup.optJSONObject("state");if(backup.optInt("version")!=1||state==null)throw new Exception("请选择从手机版导出的完整备份 JSON");
        runOnUiThread(()->{if(destroyed)return;dialogBuilder().setTitle("恢复手机备份？").setMessage("备份含 "+items(state,"accounts").length()+" 个账户、"+items(state,"transactions").length()+" 笔账单。\n\n恢复会替换手机当前内容；恢复前会自动留存完整备份。恢复后请核对账本与同步状态。").setNegativeButton("取消",null).setPositiveButton("恢复",(dialog,which)->act(()->{store.restoreBackup(backup);pairing=null;page=0;render();toast("手机备份已恢复，请核对账本");})).show();});
        }catch(Exception error){runOnUiThread(()->{if(!destroyed)error(error.getMessage());});}},"ledger-import").start();}
}
