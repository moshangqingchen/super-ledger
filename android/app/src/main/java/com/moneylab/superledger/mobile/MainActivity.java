package com.moneylab.superledger.mobile;

import android.app.Activity;
import android.app.AlertDialog;
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
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity implements AppUpdater.Listener {
    public static final String ACTION_CHANGED = "com.moneylab.superledger.mobile.CHANGED";
    private static final int BG = 0xFFF7F6F2, INK = 0xFF252738, MUTED = 0xFF7D8190, PURPLE = 0xFF6254D9, LINE = 0xFFE7E7EF, GREEN = 0xFF248C6C, RED = 0xFFD15E64;
    private LedgerStore store;
    private LinearLayout root, body;
    private int page, visibleTransactions = 100;
    private boolean receiverRegistered, destroyed;
    private SyncClient.Pairing pairing;
    private String syncMessage = "", lastError = "";
    private boolean recoveryAfterExport;
    private AppUpdater updater;
    private boolean resumed, updateDialogShowing;
    private final BroadcastReceiver receiver = new BroadcastReceiver() { @Override public void onReceive(Context context, Intent intent) { render(); } };
    private interface Action { void run() throws Exception; }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) page = saved.getInt("page", 0);
        try { store = LedgerStore.get(this); } catch (Exception e) { showFatal(e); return; }
        updater = AppUpdater.get(this);
        IntentFilter filter = new IntentFilter(ACTION_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED); else registerReceiver(receiver, filter);
        receiverRegistered = true; render();
    }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); out.putInt("page", page); }
    @Override protected void onResume() { super.onResume(); resumed = true; if (store != null) render(); if (updater != null) { updater.attach(this); updater.check(false); } }
    @Override protected void onPause() { resumed = false; if (updater != null) updater.detach(this); super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; if (updater != null) updater.detach(this); if (receiverRegistered) unregisterReceiver(receiver); super.onDestroy(); }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (focused) maybeShowUpdateUi(); }
    @Override public void onUpdaterChanged() {
        if (destroyed || !resumed) return;
        if (page == 3 && body != null) {
            int scrollY = body.getParent() instanceof ScrollView ? ((ScrollView) body.getParent()).getScrollY() : 0;
            render(); if (body != null && body.getParent() instanceof ScrollView) { ScrollView scroll = (ScrollView) body.getParent(); scroll.post(() -> scroll.scrollTo(0, scrollY)); }
        }
        maybeShowUpdateUi();
    }
    private void maybeShowUpdateUi() {
        if (destroyed || !resumed || !hasWindowFocus() || updateDialogShowing || updater == null || store == null || store.isSyncing()) return;
        Intent confirmation = updater.consumeConfirmation();
        if (confirmation != null) { try { startActivityForResult(confirmation, AppUpdater.INSTALL_CONFIRM_REQUEST); } catch (Exception error) { updater.installerReturned(); error("无法打开系统安装确认界面，请在设置中重新点「安装更新」。"); } return; }
        if (updater.consumeInstallRequest()) { act(() -> updater.requestInstall(this)); return; }
        UpdatePolicy.Release release = updater.consumeOffer(); if (release == null) return;
        String notes = release.notes.length() > 1500 ? release.notes.substring(0, 1500) + "…" : release.notes;
        updateDialogShowing = true;
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("超级账本 " + release.version + " 可以更新了")
            .setMessage(notes + "\n\n安装包约 " + String.format(Locale.CHINA, "%.1f", release.size / 1048576.0) + " MB。确认后下载，由安卓系统完成同包覆盖升级，保留手机账本。")
            .setNegativeButton("稍后", null).setPositiveButton("下载并更新", (d, w) -> { page = 3; updater.download(); render(); }).create();
        dialog.setOnDismissListener(d -> { updateDialogShowing = false; }); dialog.show();
    }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void act(Action action) { try { action.run(); } catch (Exception e) { error(e.getMessage()); } }
    private void error(String message) { new AlertDialog.Builder(this).setTitle("暂时无法完成").setMessage(message == null ? "请稍后重试，已有记录仍保留。" : message).setPositiveButton("知道了", null).show(); }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_SHORT).show(); }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable; }
    private TextView text(String value, int size, int color, boolean bold) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); view.setLineSpacing(dp(3), 1); return view; }
    private TextView label(String value) { TextView v = text(value, 13, MUTED, false); v.setPadding(0, dp(4), 0, dp(6)); return v; }
    private LinearLayout column() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    private LinearLayout row() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.HORIZONTAL); layout.setGravity(Gravity.CENTER_VERTICAL); return layout; }
    private void gap(LinearLayout parent, int height) { parent.addView(new View(this), new LinearLayout.LayoutParams(1, dp(height))); }
    private void divider(LinearLayout parent) { View view = new View(this); view.setBackgroundColor(LINE); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.topMargin = dp(12); params.bottomMargin = dp(12); parent.addView(view, params); }
    private LinearLayout card() { LinearLayout card = column(); card.setBackground(rounded(Color.WHITE, 20)); card.setPadding(dp(18), dp(18), dp(18), dp(18)); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(14); body.addView(card, params); return card; }
    private Button button(String value, boolean primary, Action action) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false); button.setTextSize(14); button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setTextColor(primary ? Color.WHITE : PURPLE); button.setBackground(rounded(primary ? PURPLE : 0xFFF0EDFD, 13)); button.setPadding(dp(14), dp(10), dp(14), dp(10)); button.setMinHeight(dp(46)); button.setMinimumHeight(dp(46)); button.setElevation(0); button.setOnClickListener(v -> act(action)); return button;
    }
    private void addButton(LinearLayout parent, String value, boolean primary, Action action) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(48)); params.topMargin = dp(10); parent.addView(button(value, primary, action), params); }
    private void showFatal(Exception error) { LinearLayout panel = column(); panel.setPadding(dp(24), dp(60), dp(24), dp(24)); panel.addView(text("手机账本暂时无法读取", 24, INK, true)); panel.addView(label("原文件已保留，应用不会自动创建空账本覆盖你的数据。\n" + error.getMessage())); setContentView(panel); }
    private void render() {
        if (destroyed || store == null) return;
        try {
            JSONObject data = store.snapshot(); root = column(); root.setBackgroundColor(BG);
            root.setOnApplyWindowInsetsListener((v, insets) -> { v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
            LinearLayout header = row(); header.setPadding(dp(22), dp(18), dp(22), dp(14));
            TextView mark = text("账", 20, Color.WHITE, true); mark.setGravity(Gravity.CENTER); mark.setBackground(rounded(PURPLE, 13)); header.addView(mark, new LinearLayout.LayoutParams(dp(43), dp(43)));
            LinearLayout titles = column(); titles.setPadding(dp(12), 0, 0, 0); titles.addView(text("超级账本", 21, INK, true)); titles.addView(text("MONEY LAB  ·  随身记", 10, MUTED, true)); header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
            TextView badge = text(store.isSyncing() ? "同步中" : data.isNull("bookId") ? "未配对" : "本地保存", 11, PURPLE, true); badge.setPadding(dp(10), dp(7), dp(10), dp(7)); badge.setBackground(rounded(0xFFEEEBFB, 20)); header.addView(badge); root.addView(header);
            ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false); body = column(); body.setPadding(dp(20), dp(8), dp(20), dp(18)); scroll.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
            if (page == 0) renderLedger(data); else if (page == 1) renderReview(data); else if (page == 2) renderSync(data); else renderSettings(data);
            LinearLayout tabs = row(); tabs.setPadding(dp(10), dp(8), dp(10), dp(8)); tabs.setBackgroundColor(Color.WHITE);
            int review = data.getJSONArray("pending").length() + data.getJSONArray("conflicts").length();
            String[] names = {"账本", "待确认" + (review > 0 ? " · " + review : ""), "扫码同步", "设置"};
            for (int i = 0; i < names.length; i++) { final int target = i; TextView tab = text(names[i], 13, page == i ? PURPLE : MUTED, page == i); tab.setGravity(Gravity.CENTER); tab.setPadding(dp(2), dp(14), dp(2), dp(14)); if (page == i) tab.setBackground(rounded(0xFFEEEBFB, 13)); tab.setOnClickListener(v -> { page = target; render(); }); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(48), 1); p.leftMargin = dp(2); p.rightMargin = dp(2); tabs.addView(tab, p); }
            root.addView(tabs); setContentView(root); root.requestApplyInsets(); root.post(this::maybeShowUpdateUi);
        } catch (Exception e) { showFatal(e); }
    }
    private static JSONObject findAccount(JSONObject state, String id) throws Exception { JSONArray accounts = state.getJSONArray("accounts"); for (int i = 0; i < accounts.length(); i++) if (id.equals(accounts.getJSONObject(i).optString("id"))) return accounts.getJSONObject(i); return null; }
    private static String accountName(JSONObject account) { if (account == null) return "未选账户"; return account.optString("name", "账户") + (account.optString("lastFour").isEmpty() ? "" : " · " + account.optString("lastFour")); }
    private static String money(long amount, String currency) { int digits = currency.equals("JPY") || currency.equals("KRW") ? 0 : 2; return (currency.equals("CNY") ? "¥" : currency + " ") + BigDecimal.valueOf(amount, digits).toPlainString(); }
    private static String when(long millis) { return millis <= 0 ? "尚未同步" : new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date(millis)); }
    private void renderLedger(JSONObject data) throws Exception {
        JSONObject state = data.getJSONObject("state"); JSONArray transactions = state.getJSONArray("transactions"), accounts = state.getJSONArray("accounts"); String month = LedgerStore.today().substring(0, 7); long expense = 0, income = 0;
        for (int i = 0; i < transactions.length(); i++) { JSONObject tx = transactions.getJSONObject(i); if (!tx.optString("date").startsWith(month) || !tx.optString("currency", "CNY").equals("CNY")) continue; if (tx.optString("type").equals("expense")) expense += tx.optLong("amount"); if (tx.optString("type").equals("income")) income += tx.optLong("amount"); }
        LinearLayout summary = card(); summary.setBackground(rounded(0xFF292646, 24)); summary.addView(text(month.replace('-', '年') + "月 · 人民币支出", 13, 0xFFC5C1DD, false)); gap(summary, 8); summary.addView(text(money(expense, "CNY"), 36, Color.WHITE, true)); gap(summary, 10); summary.addView(text("本月收入 " + money(income, "CNY") + "    待上传 " + data.getJSONArray("operations").length() + " 项", 12, 0xFFD2CEE5, false));
        addButton(summary, "＋ 记一笔", true, () -> editTransaction(null, null));
        if (data.isNull("bookId")) {
            LinearLayout welcome = card(); welcome.addView(text("先与电脑连接一次", 18, INK, true)); welcome.addView(label("在电脑打开「手机同步」，用这里的扫码功能取得账户。出门后可离线记账，回来再同步。")); addButton(welcome, "去扫码连接", false, () -> { page = 2; render(); });
        }
        if (!data.optBoolean("captureEnabled") || !notificationGranted()) { LinearLayout hint = card(); hint.addView(text("自动记账尚未开启", 16, INK, true)); hint.addView(label("开启付款通知访问，并为常用支付来源选择账户。信息不明确的通知会进入待确认。")); addButton(hint, "设置自动记账", false, () -> { page = 3; render(); }); }
        if (accounts.length() > 0) {
            LinearLayout section = card(); section.addView(text("我的账户", 17, INK, true));
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i); long balance = account.optLong("openingBalance");
                for (int j = 0; j < transactions.length(); j++) { JSONObject tx = transactions.getJSONObject(j); if (tx.optString("date").compareTo(LedgerStore.today()) > 0) continue; if (tx.optString("accountId").equals(account.optString("id"))) balance += tx.optString("type").equals("income") ? tx.optLong("amount") : -tx.optLong("amount"); if (tx.optString("type").equals("transfer") && tx.optString("toAccountId").equals(account.optString("id"))) balance += tx.has("toAmount") ? tx.optLong("toAmount") : tx.optLong("amount"); }
                LinearLayout r = row(); r.setPadding(0, dp(12), 0, dp(4)); r.addView(text(accountName(account), 14, INK, false), new LinearLayout.LayoutParams(0, -2, 1)); r.addView(text(money(balance, account.optString("currency", "CNY")), 15, INK, true)); section.addView(r);
            }
        }
        LinearLayout recent = card(); recent.addView(text("账单明细", 18, INK, true)); recent.addView(label("包含电脑账单和本机待同步记录"));
        List<JSONObject> list = new ArrayList<>(); for (int i = 0; i < transactions.length(); i++) list.add(transactions.getJSONObject(i)); Collections.sort(list, (a, b) -> b.optString("date").compareTo(a.optString("date")));
        if (list.isEmpty()) recent.addView(label("还没有账单。从第一笔开始，让花销清清楚楚。"));
        for (int i = 0; i < Math.min(list.size(), visibleTransactions); i++) { final JSONObject tx = list.get(i); if (i > 0) divider(recent); addTransactionRow(recent, tx, state); recent.getChildAt(recent.getChildCount() - 1).setOnClickListener(v -> act(() -> editTransaction(tx, null))); }
        if (list.size() > visibleTransactions) addButton(recent, "查看更多（还有 " + (list.size() - visibleTransactions) + " 笔）", false, () -> { visibleTransactions += 100; render(); });
    }
    private void addTransactionRow(LinearLayout parent, JSONObject tx, JSONObject state) throws Exception {
        LinearLayout r = row(); r.setPadding(0, dp(4), 0, dp(4)); LinearLayout detail = column(); detail.addView(text(tx.optString("title", "账单"), 15, INK, true)); detail.addView(text(tx.optString("date") + " · " + accountName(findAccount(state, tx.optString("accountId"))) + " · " + tx.optString("category"), 11, MUTED, false)); r.addView(detail, new LinearLayout.LayoutParams(0, -2, 1)); String type = tx.optString("type"); TextView amount = text((type.equals("income") ? "+" : type.equals("expense") ? "−" : "↔ ") + money(tx.optLong("amount"), tx.optString("currency", "CNY")), 16, type.equals("income") ? GREEN : INK, true); amount.setPadding(dp(10), 0, 0, 0); r.addView(amount); parent.addView(r);
    }
    private void renderReview(JSONObject data) throws Exception {
        body.addView(text("确认一下，更安心", 25, INK, true)); body.addView(label("账户不明、退款和疑似重复的交易，会先留在这里。")); gap(body, 10);
        JSONArray conflicts = data.getJSONArray("conflicts"), pending = data.getJSONArray("pending"), operations = data.getJSONArray("operations");
        for (int i = 0; i < conflicts.length(); i++) {
            final JSONObject conflict = conflicts.getJSONObject(i); JSONObject op = null; for (int j = 0; j < operations.length(); j++) if (conflict.optString("operationId").equals(operations.getJSONObject(j).optString("id"))) op = operations.getJSONObject(j);
            if (op == null) continue;
            final JSONObject operation = op; LinearLayout c = card(); c.addView(text("同步需要确认", 17, RED, true)); c.addView(label(conflict.optString("reason", "两端记录有变化")));
            JSONObject phone = op.optJSONObject("transaction"); if (phone == null) phone = op.optJSONObject("base"); if (phone != null) c.addView(text((op.optString("kind").equals("delete") ? "手机希望删除：" : "手机记录：") + phone.optString("title") + "  " + money(phone.optLong("amount"), phone.optString("currency", "CNY")), 14, INK, false));
            JSONObject candidate = conflict.optJSONObject("candidate"), current = conflict.optJSONObject("current"); JSONObject shown = candidate != null ? candidate : current;
            if (shown != null) c.addView(label("电脑记录：" + shown.optString("date") + " " + shown.optString("title") + " " + money(shown.optLong("amount"), shown.optString("currency", "CNY"))));
            addButton(c, "查看处理方式", false, () -> resolveConflict(conflict, operation));
        }
        for (int i = 0; i < pending.length(); i++) {
            final JSONObject item = pending.getJSONObject(i), tx = item.getJSONObject("transaction"); LinearLayout c = card(); c.addView(text(tx.optString("title", "付款通知"), 18, INK, true)); c.addView(text(money(tx.optLong("amount"), tx.optString("currency", "CNY")), 25, PURPLE, true)); c.addView(label(item.optString("reason"))); c.addView(text(tx.optString("date") + " · " + sourceName(data, item.optString("sourcePackage")), 12, MUTED, false));
            addButton(c, "核对并入账", true, () -> editTransaction(tx, item)); addButton(c, "忽略这条通知", false, () -> new AlertDialog.Builder(this).setTitle("忽略这条通知？").setMessage("它不会进入账本。若是已记录的消费或账户间转账，可以忽略。").setNegativeButton("返回", null).setPositiveButton("忽略", (d, w) -> act(() -> { store.dismissPending(item.getString("id")); render(); })).show());
        }
        if (pending.length() + conflicts.length() == 0) { LinearLayout empty = card(); empty.addView(text("全部处理好了", 21, GREEN, true)); empty.addView(label("新收到的付款通知会自动识别。需要你确认时，这里会显示提醒。")); }
    }
    private void resolveConflict(JSONObject conflict, JSONObject operation) throws Exception {
        boolean duplicate = conflict.optJSONObject("candidate") != null;
        new AlertDialog.Builder(this).setTitle(duplicate ? "这是不是同一笔消费？" : "选择保留的修改")
            .setMessage(conflict.optString("reason") + (duplicate ? "\n确定是两笔不同交易时，才选择保留两笔。" : "\n手机修改会以当前电脑记录为基础，下一次扫码时再提交。"))
            .setNegativeButton("稍后处理", null)
            .setNeutralButton(duplicate ? "同一笔，采用电脑" : "采用电脑记录", (d, w) -> act(() -> { store.resolveConflict(operation.getString("id"), false); render(); }))
            .setPositiveButton(duplicate ? "保留两笔" : "保留手机修改", (d, w) -> act(() -> { store.resolveConflict(operation.getString("id"), true); render(); toast("已处理，下次扫码时提交"); })).show();
    }
    private void renderSync(JSONObject data) throws Exception {
        body.addView(text("回到电脑旁，一扫同步", 25, INK, true)); body.addView(label("在外记账 · 本地保存 · 回来补齐")); gap(body, 12);
        LinearLayout steps = card(); steps.addView(text("连接你的电脑", 19, INK, true)); gap(steps, 10); steps.addView(text("01  手机和电脑连接同一 Wi-Fi / 热点\n\n02  电脑端打开「手机同步」\n\n03  扫描电脑显示的临时二维码", 15, INK, false)); gap(steps, 14); steps.addView(label("不需要云端账号。二维码只用于临时配对，账本内容加密传输。关闭电脑同步窗口或二维码过期后，需要重新扫码。"));
        Button scan = button(store.isSyncing() ? "正在同步…" : "扫一扫，开始同步", true, () -> startActivityForResult(new Intent(this, ScanActivity.class), 31)); scan.setEnabled(!store.isSyncing()); steps.addView(scan, new LinearLayout.LayoutParams(-1, dp(52))); addButton(steps, "粘贴配对内容", false, this::pastePairing);
        if (!syncMessage.isEmpty()) { LinearLayout result = card(); result.addView(text(store.isSyncing() ? "正在连接" : "同步结果", 18, INK, true)); result.addView(label(syncMessage)); }
        LinearLayout state = card(); state.addView(text("同步状态", 17, INK, true)); state.addView(label("上次成功：" + when(data.optLong("lastSyncAt")) + "\n待上传修改：" + data.getJSONArray("operations").length() + " 项\n待处理通知：" + data.getJSONArray("pending").length() + " 条\n需要确认的冲突：" + data.getJSONArray("conflicts").length() + " 项"));
        state.addView(label("同步中断不会删除手机记录。信息不明确的通知留在手机待确认，核对入账后才上传。电脑端维护账户、订阅和外币设置。"));
        if (!data.isNull("bookId")) addButton(state, "连接另一份电脑账本", false, () -> new AlertDialog.Builder(this).setTitle("切换电脑账本？").setMessage("仅在没有待同步修改时可以切换。手机会清除已下载的电脑账本和账户映射；待确认通知保留。原电脑上的数据不受影响。").setNegativeButton("取消", null).setPositiveButton("切换", (d, w) -> act(() -> { store.reconnectEmpty(); pairing = null; render(); })).show());
        addButton(state, "导出手机完整备份", false, () -> exportBackup(false));
        if (!data.isNull("bookId")) addButton(state, "电脑账本已重置 / 恢复配对", false, () -> new AlertDialog.Builder(this).setTitle("先保留手机备份").setMessage("适用于电脑账本已重置、导入或更换，无法再同步旧队列的情况。请先导出完整手机备份，再选择是否恢复配对；此时不会丢弃任何手机记录。").setNegativeButton("取消", null).setPositiveButton("先导出备份", (d, w) -> act(() -> exportBackup(true))).show());
    }
    private void pastePairing() { EditText input = new EditText(this); input.setHint("粘贴电脑端的配对内容"); input.setMinLines(3); input.setMaxLines(8); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); new AlertDialog.Builder(this).setTitle("手动配对").setView(input).setNegativeButton("取消", null).setPositiveButton("同步", (d, w) -> act(() -> startSync(input.getText().toString()))).show(); }
    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code == AppUpdater.INSTALL_PERMISSION_REQUEST && updater != null) updater.permissionReturned();
        if (code == AppUpdater.INSTALL_CONFIRM_REQUEST && updater != null) updater.installerReturned();
        if (code == 31 && result == RESULT_OK && intent != null) act(() -> startSync(intent.getStringExtra("pairing")));
        if (code == 44 && result == RESULT_OK && intent != null && intent.getData() != null) act(() -> {
            try (OutputStream output = getContentResolver().openOutputStream(intent.getData(), "wt")) { if (output == null) throw new Exception("无法打开备份位置"); output.write(store.snapshot().toString(2).getBytes(StandardCharsets.UTF_8)); output.flush(); }
            toast("手机完整备份已保存");
            if (recoveryAfterExport) new AlertDialog.Builder(this).setTitle("备份完成，恢复配对？").setMessage("旧账本的未同步新增/修改会转入待确认，需重新选择账户后手动入账；旧删除操作会保存在手机归档和刚导出的备份中，不会自动删除新账本的数据。已下载的旧电脑账本和账户映射将清除。")
                .setNegativeButton("先不恢复", null).setPositiveButton("存档并重新配对", (d, w) -> act(() -> { store.archiveForReconnect(); pairing = null; syncMessage = "旧队列已存档。请扫描电脑新二维码，再处理待确认中的旧账单。"; render(); })).show();
            recoveryAfterExport = false;
        });
    }
    private void exportBackup(boolean recovery) throws Exception {
        if (store.isSyncing()) throw new Exception("正在同步，请完成后再导出备份"); recoveryAfterExport = recovery;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "超级账本-手机备份-" + LedgerStore.today() + ".json"); startActivityForResult(intent, 44);
    }
    private void startSync(String raw) throws Exception {
        pairing = SyncClient.parsePairing(raw); store.startSync(); page = 2; syncMessage = "正在连接电脑，并安全交换账本…"; render(); final SyncClient.Pairing selected = pairing;
        new Thread(() -> {
            String result;
            try {
                int added = 0, updated = 0, deleted = 0, duplicates = 0, rounds = 0;
                while (true) {
                    JSONObject request = store.syncRequest(UUID.randomUUID().toString());
                    JSONObject response = SyncClient.synchronize(selected, request); store.applyResponse(response, request);
                    JSONObject summary = response.optJSONObject("summary"); if (summary != null) { added += summary.optInt("added"); updated += summary.optInt("updated"); deleted += summary.optInt("deleted"); duplicates += summary.optInt("duplicates"); }
                    rounds++; if (request.getJSONArray("operations").length() == 0 || rounds >= 20 || store.syncRequest(UUID.randomUUID().toString()).getJSONArray("operations").length() == 0) break;
                }
                JSONObject latest = store.snapshot(); result = "同步完成\n新增 " + added + " 笔 · 更新 " + updated + " 笔 · 删除 " + deleted + " 笔\n已去重 " + duplicates + " 笔 · 待确认冲突 " + latest.getJSONArray("conflicts").length() + " 项\n剩余待上传 " + latest.getJSONArray("operations").length() + " 项";
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
    private static String sourceName(JSONObject data, String pkg) { JSONObject source = data.optJSONObject("sources").optJSONObject(pkg); return source == null ? pkg : source.optString("name", pkg); }
    private void renderSettings(JSONObject data) throws Exception {
        body.addView(text("让记账适合你的习惯", 25, INK, true)); body.addView(label("权限由你开启，自动识别范围由你决定。")); gap(body, 10);
        renderUpdates();
        LinearLayout automatic = card(); LinearLayout switchRow = row(); switchRow.addView(text("自动识别付款通知", 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); Switch capture = new Switch(this); capture.setChecked(data.optBoolean("captureEnabled")); switchRow.addView(capture); automatic.addView(switchRow);
        automatic.addView(label("仅处理你选中的支付/银行应用交易通知；普通聊天和验证码不入账。明确金额但账户不明的通知进入待确认。系统没有提供的内容无法读取。"));
        capture.setOnCheckedChangeListener((v, checked) -> { if (!checked) act(() -> { store.setCapture(false); render(); }); else new AlertDialog.Builder(this).setTitle("开启付款通知识别")
            .setMessage("系统的通知访问权限范围较广。超级账本只在本机筛选你选中应用的财务通知，用于记账；不会上传普通聊天或验证码。需要确认的交易摘要只保存在手机，入账后移除摘要。你可随时关闭采集或在系统设置撤销权限。")
            .setNegativeButton("暂不开启", (d, w) -> render()).setPositiveButton("开启并授权", (d, w) -> act(() -> { store.setCapture(true); if (!notificationGranted()) startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); else render(); })).setOnCancelListener(d -> render()).show(); });
        automatic.addView(text(notificationGranted() ? "● 通知访问已授权" : "○ 通知访问尚未授权", 13, notificationGranted() ? GREEN : RED, true)); addButton(automatic, "打开系统通知权限", false, () -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        automatic.addView(label("最近识别：" + (data.optLong("lastCaptureAt") == 0 ? "尚无交易通知" : when(data.optLong("lastCaptureAt")))));
        if (!data.optString("captureError").isEmpty()) automatic.addView(text(data.optString("captureError"), 13, RED, true));
        LinearLayout sources = card(); sources.addView(text("付款来源与账户", 18, INK, true)); sources.addView(label("点选来源，设置实际扣款账户。微信/支付宝也可能使用银行卡，切换支付方式后请核对映射；未指定账户时会进入待确认。银行卡尾号能唯一匹配时优先采用尾号。"));
        JSONObject sourceMap = data.getJSONObject("sources"); List<String> packages = new ArrayList<>(); Iterator<String> keys = sourceMap.keys(); while (keys.hasNext()) packages.add(keys.next()); Collections.sort(packages);
        for (String pkg : packages) {
            JSONObject info = sourceMap.getJSONObject(pkg); LinearLayout r = row(); r.setPadding(0, dp(12), 0, dp(10)); LinearLayout desc = column(); desc.addView(text(info.optString("name", pkg), 15, INK, true)); String mapped = data.getJSONObject("mappings").optString(pkg); desc.addView(text((info.optBoolean("enabled") ? "已启用" : "已停用") + " · " + (mapped.isEmpty() ? "待确认账户" : accountName(findAccount(data.getJSONObject("state"), mapped))), 11, MUTED, false)); r.addView(desc, new LinearLayout.LayoutParams(0, -2, 1)); r.addView(text("设置 ›", 12, PURPLE, true)); r.setOnClickListener(v -> act(() -> sourceSettings(pkg))); sources.addView(r);
        }
        addButton(sources, "添加其他银行 / 短信应用", false, this::chooseSourceApp);
        LinearLayout help = card(); help.addView(text("vivo 手机使用提示", 17, INK, true)); help.addView(label("请在系统设置中允许超级账本后台运行和自启动，避免省电清理导致漏记。设置名称以你的系统版本为准。若「通知使用权」不可选，查看应用信息菜单中的受限设置提示。\n\n付款应用需要实际发出含金额的通知。现金、未显示金额的通知及系统隐藏的信息需要手工补记或在电脑对账。银行短信可选择短信应用作为来源，前提是通知显示银行交易内容。")); addButton(help, "打开本应用系统设置", false, () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        LinearLayout privacy = card(); privacy.addView(text("本地优先，随时可控", 17, INK, true)); privacy.addView(label("手机记录保存在应用私有目录，关闭系统云备份。账本只通过扫码连接的局域网传输，并使用临时配对密钥加密。更新功能会通过手机的正常 HTTPS / 系统代理设置请求指定 GitHub 仓库的公开版本与安装包，不读取或上传账本。卸载应用会删除手机数据，请先完成电脑同步；正常覆盖升级保留数据。\n\n手机版 " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName + " · 支持人民币收入与支出编辑。外币、账户转账、账户管理与订阅设置请在电脑端完成。"));
    }
    private void renderUpdates() throws Exception {
        if (updater == null) return; AppUpdater.Snapshot update = updater.snapshot();
        LinearLayout panel = card(); panel.addView(text("应用更新", 18, INK, true));
        panel.addView(label("当前版本 " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName + (update.version.isEmpty() ? "" : " · 可用版本 " + update.version)));
        panel.addView(text(update.message, 13, update.phase.equals("ready") ? GREEN : MUTED, false));
        if (update.phase.equals("downloading") && update.size > 0) {
            gap(panel, 8); panel.addView(text(String.format(Locale.CHINA, "%.1f / %.1f MB · %d%%", update.downloaded / 1048576.0, update.size / 1048576.0, Math.min(100, update.downloaded * 100 / update.size)), 14, PURPLE, true));
            addButton(panel, "取消下载", false, () -> updater.cancelDownload());
        }
        if (update.canInstall) addButton(panel, "安装更新", true, () -> { if (store.isSyncing()) throw new Exception("请先完成账本同步，再安装更新"); updater.requestInstall(this); });
        else if (update.canDownload) addButton(panel, "下载并更新", true, () -> updater.download());
        Button check = button(update.busy ? "正在处理更新…" : "检查更新", false, () -> updater.check(true)); check.setEnabled(!update.busy); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(46)); params.topMargin = dp(10); panel.addView(check, params);
        panel.addView(label("启动时最多每 6 小时检查一次。发现新版会提示，下载由你决定；安装前验证发布签名、文件校验值和原应用签名。\n上次检查：" + (update.checkedAt == 0 ? "尚未检查" : when(update.checkedAt))));
    }
    private List<JSONObject> cnyAccounts(JSONObject state) throws Exception { List<JSONObject> accounts = new ArrayList<>(); JSONArray array = state.getJSONArray("accounts"); for (int i = 0; i < array.length(); i++) if (array.getJSONObject(i).optString("currency", "CNY").equals("CNY")) accounts.add(array.getJSONObject(i)); return accounts; }
    private Spinner spinner(List<String> labels) { Spinner spinner = new Spinner(this); ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels); adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); spinner.setAdapter(adapter); spinner.setMinimumHeight(dp(48)); return spinner; }
    private void sourceSettings(String pkg) throws Exception {
        JSONObject data = store.snapshot(), source = data.getJSONObject("sources").getJSONObject(pkg); List<JSONObject> accounts = cnyAccounts(data.getJSONObject("state"));
        LinearLayout view = column(); view.setPadding(dp(20), dp(8), dp(20), dp(10)); Switch enabled = new Switch(this); enabled.setText("识别这个应用的交易通知"); enabled.setChecked(source.optBoolean("enabled")); view.addView(enabled); view.addView(label("没有尾号时使用的实际扣款账户")); List<String> names = new ArrayList<>(); names.add("每次待确认（不自动选账户）"); int selected = 0;
        for (int i = 0; i < accounts.size(); i++) { names.add(accountName(accounts.get(i))); if (accounts.get(i).optString("id").equals(data.getJSONObject("mappings").optString(pkg))) selected = i + 1; }
        Spinner mapping = spinner(names); mapping.setSelection(selected); view.addView(mapping); view.addView(label("更换银行卡、零钱或余额付款时，请更新这里的账户。二维码同步不会替你读取真实余额。"));
        new AlertDialog.Builder(this).setTitle(source.optString("name", pkg)).setView(view).setNegativeButton("取消", null).setPositiveButton("保存", (d, w) -> act(() -> { int index = mapping.getSelectedItemPosition(); store.setSource(pkg, source.optString("name", pkg), enabled.isChecked(), index > 0 ? accounts.get(index - 1).getString("id") : ""); render(); })).show();
    }
    private void chooseSourceApp() throws Exception {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER); List<ResolveInfo> apps = getPackageManager().queryIntentActivities(intent, 0); Collections.sort(apps, (a, b) -> a.loadLabel(getPackageManager()).toString().compareToIgnoreCase(b.loadLabel(getPackageManager()).toString())); List<String> names = new ArrayList<>(), packages = new ArrayList<>();
        for (ResolveInfo app : apps) { String pkg = app.activityInfo.packageName; if (packages.contains(pkg) || pkg.equals(getPackageName())) continue; packages.add(pkg); names.add(app.loadLabel(getPackageManager()).toString()); }
        if (names.isEmpty()) throw new Exception("没有读取到可选应用，请先安装并打开需要记录的银行应用");
        new AlertDialog.Builder(this).setTitle("选择付款 / 银行 / 短信应用").setItems(names.toArray(new String[0]), (dialog, index) -> act(() -> { store.setSource(packages.get(index), names.get(index), true, ""); sourceSettings(packages.get(index)); render(); })).setNegativeButton("取消", null).show();
    }
    private EditText field(LinearLayout form, String name, String value, int inputType) { form.addView(label(name)); EditText input = new EditText(this); input.setText(value); input.setTextColor(INK); input.setTextSize(15); input.setInputType(inputType); input.setPadding(dp(10), dp(10), dp(10), dp(10)); input.setBackground(rounded(0xFFF3F3F8, 10)); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.bottomMargin = dp(9); form.addView(input, p); return input; }
    private void editTransaction(JSONObject original, JSONObject pending) throws Exception {
        JSONObject data = store.snapshot(), state = data.getJSONObject("state");
        if (store.isSyncing()) throw new Exception("正在同步，请稍后再编辑");
        if (original != null && (!original.optString("currency", "CNY").equals("CNY") || original.optString("type").equals("transfer"))) { new AlertDialog.Builder(this).setTitle(original.optString("title", "账单")).setMessage(original.optString("date") + "\n" + money(original.optLong("amount"), original.optString("currency", "CNY")) + "\n" + original.optString("note") + "\n\n外币和账户转账请在电脑端编辑，扫码后会更新到手机。").setPositiveButton("知道了", null).show(); return; }
        List<JSONObject> accounts = cnyAccounts(state); if (data.isNull("bookId") || accounts.isEmpty()) throw new Exception("请先在电脑添加人民币账户，再用手机扫码同步。待确认通知会一直保留。");
        ScrollView scroll = new ScrollView(this); LinearLayout form = column(); form.setPadding(dp(22), dp(8), dp(22), dp(8)); scroll.addView(form);
        if (pending != null) { form.addView(text(pending.optString("reason"), 14, RED, true)); form.addView(label("通知摘要：\n" + pending.optString("snippet"))); form.addView(label("退款请确认收支方向；账户间转账请在电脑记录转账后忽略通知，避免重复统计。")); }
        List<String> typeLabels = new ArrayList<>(); typeLabels.add("支出"); typeLabels.add("收入"); Spinner type = spinner(typeLabels); type.setSelection(original != null && original.optString("type").equals("income") ? 1 : 0); form.addView(type);
        EditText amount = field(form, "金额 · CNY", original == null ? "" : BigDecimal.valueOf(original.optLong("amount"), 2).toPlainString(), InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        List<String> accountLabels = new ArrayList<>(); accountLabels.add("请选择实际收付款账户"); int selected = 0;
        for (int i = 0; i < accounts.size(); i++) { accountLabels.add(accountName(accounts.get(i))); if (original != null && accounts.get(i).optString("id").equals(original.optString("accountId"))) selected = i + 1; }
        form.addView(label("账户")); Spinner account = spinner(accountLabels); account.setSelection(selected); form.addView(account);
        EditText title = field(form, "账单名称", original == null ? "" : original.optString("title"), InputType.TYPE_CLASS_TEXT);
        EditText category = field(form, "分类", original == null ? "其他支出" : original.optString("category"), InputType.TYPE_CLASS_TEXT);
        EditText date = field(form, "日期 · YYYY-MM-DD", original == null ? LedgerStore.today() : original.optString("date"), InputType.TYPE_CLASS_DATETIME);
        EditText note = field(form, "备注", original == null ? "" : original.optString("note"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE); note.setMaxLines(5);
        TextView validation = text("", 13, RED, false); form.addView(validation);
        AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle(pending != null ? "核对付款通知" : original == null ? "记一笔" : "编辑账单").setView(scroll).setNegativeButton("取消", null).setPositiveButton("保存", null);
        if (original != null && pending == null) builder.setNeutralButton("删除", null);
        AlertDialog dialog = builder.create(); dialog.setOnShowListener(d -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                try {
                    if (account.getSelectedItemPosition() <= 0) throw new Exception("请选择实际收付款账户"); String raw = amount.getText().toString().trim(); if (!raw.matches("[0-9]+(?:\\.[0-9]{1,2})?")) throw new Exception("金额最多保留两位小数");
                    long cents = new BigDecimal(raw).movePointRight(2).longValueExact(); JSONObject tx = original == null ? new JSONObject().put("id", "mob_" + UUID.randomUUID()) : LedgerStore.copy(original);
                    tx.put("type", type.getSelectedItemPosition() == 1 ? "income" : "expense").put("currency", "CNY").put("amount", cents).put("accountId", accounts.get(account.getSelectedItemPosition() - 1).getString("id")).put("title", title.getText().toString().trim()).put("category", category.getText().toString().trim()).put("date", date.getText().toString().trim()).put("note", note.getText().toString().trim());
                    if (tx.has("subscriptionId") && (!tx.getString("type").equals("expense") || !tx.optString("date").substring(0, Math.min(7, tx.optString("date").length())).equals(original.optString("date").substring(0, 7)))) throw new Exception("订阅账单的收支类型与所属月份请在电脑端修改");
                    store.putTransaction(tx, pending == null ? null : pending.getString("id")); dialog.dismiss(); render(); toast("已保存到手机，下次扫码同步");
                } catch (Exception e) { validation.setText(e.getMessage() == null ? "请核对填写内容" : e.getMessage()); }
            });
            if (original != null && pending == null) dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("删除这笔账单？").setMessage("删除操作会在下次扫码时同步到电脑。若两端同时修改，会先要求确认。").setNegativeButton("取消", null).setPositiveButton("删除", (confirm, w) -> act(() -> { store.deleteTransaction(original.getString("id")); dialog.dismiss(); render(); })).show());
        }); dialog.show();
    }
}
