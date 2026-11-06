package com.moneylab.superledger.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Native, presentation-only update surface. Installation always needs an explicit second tap. */
public final class MobileUpdateDialog {
    public interface Host {
        boolean canInstall();
        void onDismiss();
    }
    private final Activity activity;
    private final AppUpdater updater;
    private Host host;
    private Dialog dialog;
    private ScrollView scroll;
    private ProgressBar progress;
    private TextView progressLabel;
    private boolean disposed, confirmInstall, expanded, cancelRequested;
    private String lastKey = "", localError = "", offeredNotes = "", notesVersion = "";
    private View previousFocus;

    public MobileUpdateDialog(Activity activity, AppUpdater updater, Host host) {
        this.activity = activity;
        this.updater = updater;
        this.host = host;
    }
    public boolean isShowing() { return dialog != null && dialog.isShowing(); }
    public void showOffer(UpdatePolicy.Release release) {
        if (release != null) { if (!release.version.equals(notesVersion)) expanded = false; offeredNotes = release.notes; notesVersion = release.version; }
        show();
    }
    public void showReady() { confirmInstall = false; show(); }
    public void check() {
        if (disposed) return;
        localError = ""; confirmInstall = false;
        updater.check(true);
        show();
    }
    public void show() {
        if (disposed || activity.isFinishing() || activity.isDestroyed()) return;
        if (isShowing()) { refresh(); return; }
        previousFocus = activity.getCurrentFocus();
        final Dialog opened = new Dialog(activity, R.style.LedgerDialogTheme);
        dialog = opened;
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnDismissListener(ignored -> {
            // A queued dismissal from an older window must not clear a newer one.
            if (dialog != opened) return;
            dialog = null; scroll = null; progress = null; progressLabel = null;
            confirmInstall = false; lastKey = "";
            if (previousFocus != null && previousFocus.isAttachedToWindow()) previousFocus.requestFocus();
            previousFocus = null;
            if (!disposed && host != null) activity.getWindow().getDecorView().post(() -> { if (!disposed && host != null) host.onDismiss(); });
        });
        render(updater.snapshot());
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams attributes = window.getAttributes(); attributes.dimAmount = .28f; window.setAttributes(attributes);
            Rect visible = new Rect(); activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
            int available = visible.width() > 0 ? visible.width() : activity.getResources().getDisplayMetrics().widthPixels;
            window.setLayout(Math.min(dp(560), Math.max(dp(240), available - dp(28))), ViewGroup.LayoutParams.WRAP_CONTENT);
        }
    }
    public void refresh() {
        if (!isShowing() || disposed) return;
        AppUpdater.Snapshot state = updater.snapshot();
        if (!state.canInstall) confirmInstall = false;
        if (!"downloading".equals(state.phase)) cancelRequested = false;
        String key = state.phase + "|" + state.version + "|" + state.notes + "|" + state.message + "|" + state.busy + "|" + state.canInstall + "|" + state.checkedAt + "|" + state.sourceMode + "|" + state.sourceLabel + "|" + confirmInstall + "|" + cancelRequested + "|" + localError;
        if (!key.equals(lastKey)) render(state); else patchProgress(state);
    }
    public void dismiss() { if (dialog != null) dialog.dismiss(); }
    public void dispose() { disposed = true; host = null; dismiss(); previousFocus = null; }

    private int dp(float size) { return MobileStyle.dp(activity, size); }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(activity); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setTypeface(Typeface.create(bold ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
        view.setLineSpacing(dp(3), 1); view.setIncludeFontPadding(false); return view;
    }
    private LinearLayout column() { LinearLayout result = new LinearLayout(activity); result.setOrientation(LinearLayout.VERTICAL); return result; }
    private LinearLayout row() { LinearLayout result = new LinearLayout(activity); result.setOrientation(LinearLayout.HORIZONTAL); result.setGravity(Gravity.CENTER_VERTICAL); return result; }
    private void gap(LinearLayout parent, int amount) { parent.addView(new View(activity), new LinearLayout.LayoutParams(1, dp(amount))); }
    private void line(LinearLayout parent) { View line = new View(activity); line.setBackgroundColor(MobileStyle.LINE); parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1))); }
    private Button button(String title, boolean primary, String tag, Runnable action) {
        Button button = new Button(activity); button.setText(title); button.setTag(tag); button.setAllCaps(false);
        button.setTextSize(14); button.setTextColor(primary ? Color.WHITE : MobileStyle.ACCENT);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setBackground(MobileStyle.ripple(activity, primary ? MobileStyle.ACCENT : MobileStyle.SOFT, 13));
        button.setMinHeight(dp(48)); button.setMinimumHeight(dp(48)); button.setPadding(dp(16), dp(12), dp(16), dp(12)); button.setElevation(0);
        button.setOnClickListener(view -> action.run()); return button;
    }
    private void addButton(LinearLayout parent, String title, boolean primary, String tag, Runnable action) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(10);
        parent.addView(button(title, primary, tag, action), params);
    }
    private String currentVersion() {
        try { return "v" + activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; }
        catch (Exception ignored) { return "当前安装版本"; }
    }
    private String sourceDescription(AppUpdater.Snapshot state) {
        String mode = state.sourceMode;
        String selected = "github".equals(mode) ? "GitHub 官方" : "gh-proxy".equals(mode) ? "备用线路一 · GH-Proxy" : "ghfast".equals(mode) ? "备用线路二 · GHFast" : "自动切换";
        if (state.sourceLabel == null || state.sourceLabel.isEmpty()) return "更新线路 · " + selected;
        return (state.busy ? "当前线路 · " : "最近使用 · ") + state.sourceLabel + ("auto".equals(mode) ? "（自动切换）" : "");
    }
    private void versionStrip(LinearLayout content, AppUpdater.Snapshot state) {
        LinearLayout strip = row(); strip.setPadding(dp(15), dp(15), dp(15), dp(15));
        strip.setBackground(MobileStyle.outlined(activity, 0xFFF8F8FE, MobileStyle.LINE, 15));
        LinearLayout current = column(); current.addView(text("当前版本", 11, MobileStyle.MUTED, false)); gap(current, 7); current.addView(text(currentVersion(), 15, MobileStyle.INK, true));
        strip.addView(current, new LinearLayout.LayoutParams(0, -2, 1));
        if (!state.version.isEmpty()) {
            View arrow = MobileIcons.view(activity, "chevron", MobileStyle.MUTED, 18); strip.addView(arrow, new LinearLayout.LayoutParams(dp(18), dp(18)));
            LinearLayout next = column(); next.setPadding(dp(15), 0, 0, 0); next.addView(text("新版本", 11, MobileStyle.MUTED, false)); gap(next, 7); next.addView(text("v" + state.version, 15, MobileStyle.ACCENT, true));
            strip.addView(next, new LinearLayout.LayoutParams(0, -2, 1));
        }
        content.addView(strip); gap(content, 9);
        content.addView(text(state.size > 0 ? "Android · " + UpdatePresentation.bytes(state.size) : "Android 手机版", 11, MobileStyle.MUTED, false));
        gap(content, 6); content.addView(text(sourceDescription(state), 11, MobileStyle.MUTED, false));
    }
    private void notes(LinearLayout parent, AppUpdater.Snapshot state) {
        String value = state.notes == null ? "" : state.notes.trim();
        if (value.isEmpty() && state.version.equals(notesVersion)) value = offeredNotes;
        if (value.isEmpty()) return;
        List<String> highlights = UpdatePresentation.highlights(value);
        if (!highlights.isEmpty()) {
            gap(parent, 22); parent.addView(text("这次有哪些新变化", 14, MobileStyle.INK, true)); gap(parent, 5);
            for (int i = 0; i < highlights.size(); i++) {
                LinearLayout item = row(); item.setGravity(Gravity.TOP); item.setPadding(0, dp(11), 0, dp(4));
                TextView number = text("0" + (i + 1), 11, MobileStyle.ACCENT, true); number.setGravity(Gravity.CENTER); number.setBackground(MobileStyle.surface(activity, MobileStyle.SOFT, 8));
                LinearLayout.LayoutParams numberParams = new LinearLayout.LayoutParams(dp(28), dp(28)); numberParams.rightMargin = dp(11); item.addView(number, numberParams);
                item.addView(text(highlights.get(i), 13, MobileStyle.INK, false), new LinearLayout.LayoutParams(0, -2, 1)); parent.addView(item);
            }
        }
        gap(parent, 15); line(parent); gap(parent, 4);
        TextView full = text(value, 12, MobileStyle.MUTED, false); full.setPadding(dp(12), dp(12), dp(12), dp(12));
        full.setBackground(MobileStyle.surface(activity, MobileStyle.BG, 12)); full.setVisibility(expanded ? View.VISIBLE : View.GONE);
        Button details = button(expanded ? "收起完整说明  −" : "展开完整说明  ＋", false, "details", () -> {});
        details.setBackgroundColor(Color.TRANSPARENT); details.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); details.setPadding(0, dp(10), 0, dp(10));
        details.setOnClickListener(view -> { expanded = !expanded; full.setVisibility(expanded ? View.VISIBLE : View.GONE); details.setText(expanded ? "收起完整说明  −" : "展开完整说明  ＋"); });
        parent.addView(details, new LinearLayout.LayoutParams(-1, -2)); parent.addView(full, new LinearLayout.LayoutParams(-1, -2));
    }
    private void patchProgress(AppUpdater.Snapshot state) {
        if (progress == null || progressLabel == null) return;
        boolean connecting = state.downloaded <= 0;
        progress.setIndeterminate(connecting || state.size <= 0); progress.setProgress(UpdatePresentation.percent(state.downloaded, state.size));
        progressLabel.setText(connecting ? "正在连接下载服务器…" : UpdatePresentation.bytes(state.downloaded) + " / " + UpdatePresentation.bytes(state.size) + "  ·  " + UpdatePresentation.percent(state.downloaded, state.size) + "%");
    }
    private void startDownload() { localError = ""; confirmInstall = false; updater.download(); refresh(); }
    private void openBrowser() {
        localError = "";
        try { updater.openDownloadInBrowser(activity); dismiss(); }
        catch (Exception error) { localError = error.getMessage() == null ? "暂时无法打开浏览器，请稍后重试。" : error.getMessage(); render(updater.snapshot()); }
    }
    private void browserFallback(LinearLayout parent) {
        addButton(parent, "浏览器下载", false, "browser", this::openBrowser);
        gap(parent, 10);
        parent.addView(text("浏览器使用所选线路。若仍不畅，可先取消下载，在设置里更换线路重试，无需卸载。", 11, MobileStyle.MUTED, false));
    }
    private void install() {
        if (!updater.snapshot().canInstall) { refresh(); return; }
        if (host == null || !host.canInstall()) { localError = "请先完成账本同步，再安装更新。"; confirmInstall = false; render(updater.snapshot()); return; }
        localError = ""; confirmInstall = true; render(updater.snapshot());
    }
    private void confirm() {
        if (!confirmInstall || !updater.snapshot().canInstall) return;
        if (host == null || !host.canInstall()) { localError = "请先完成账本同步，再安装更新。"; confirmInstall = false; render(updater.snapshot()); return; }
        confirmInstall = false;
        try { updater.requestInstall(activity); dismiss(); }
        catch (Exception error) { localError = error.getMessage() == null ? "暂时无法打开安装程序，请稍后重试。" : error.getMessage(); render(updater.snapshot()); }
    }
    private void render(AppUpdater.Snapshot state) {
        if (dialog == null || disposed) return;
        int oldScroll = scroll == null ? 0 : scroll.getScrollY();
        Object focusTag = dialog.getCurrentFocus() == null ? null : dialog.getCurrentFocus().getTag();
        lastKey = state.phase + "|" + state.version + "|" + state.notes + "|" + state.message + "|" + state.busy + "|" + state.canInstall + "|" + state.checkedAt + "|" + state.sourceMode + "|" + state.sourceLabel + "|" + confirmInstall + "|" + cancelRequested + "|" + localError;
        progress = null; progressLabel = null;
        LinearLayout content = column(); content.setPadding(dp(23), dp(20), dp(23), dp(22));
        content.setBackground(MobileStyle.surface(activity, Color.WHITE, 24));
        LinearLayout top = row();
        FrameLayout symbol = new FrameLayout(activity); symbol.setBackground(MobileStyle.surface(activity, MobileStyle.SOFT, 15));
        View glyph = MobileIcons.view(activity, state.canInstall || "idle".equals(state.phase) && state.message.contains("最新") ? "check" : "download", MobileStyle.ACCENT, 25);
        FrameLayout.LayoutParams glyphParams = new FrameLayout.LayoutParams(dp(25), dp(25), Gravity.CENTER); symbol.addView(glyph, glyphParams);
        top.addView(symbol, new LinearLayout.LayoutParams(dp(48), dp(48))); top.addView(new View(activity), new LinearLayout.LayoutParams(0, 1, 1));
        FrameLayout close = new FrameLayout(activity); close.setBackground(MobileStyle.ripple(activity, MobileStyle.BG, 13)); close.setContentDescription("关闭更新窗口"); close.setFocusable(true); close.setTag("close");
        View closeIcon = MobileIcons.view(activity, "close", MobileStyle.MUTED, 18); close.addView(closeIcon, new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER)); close.setOnClickListener(view -> dismiss());
        top.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48))); content.addView(top); gap(content, 18);
        content.addView(text("超级账本 · 应用更新", 11, MobileStyle.MUTED, false)); gap(content, 9);
        boolean checking = "checking".equals(state.phase), downloading = "downloading".equals(state.phase), installing = "installing".equals(state.phase);
        boolean latest = "idle".equals(state.phase) && state.message.contains("最新");
        String title = confirmInstall ? "准备好升级了吗？" : checking ? "正在寻找新变化" : downloading ? "新版本正在路上" : installing ? "等待系统完成安装" : state.canInstall ? "新版本，准备好了" : state.canDownload ? "给账本，升个级" : latest ? "已经是最新版本" : "让账本保持新鲜";
        String subtitle = confirmInstall ? "系统将打开安装确认，继续使用原来的账本。" : checking ? "检查版本信息，马上就好。" : downloading ? "可以在后台下载，完成后由你决定何时安装。" : installing ? "请在安卓安装窗口中继续完成升级。" : state.canInstall ? "安装包已下载并校验，随时可以升级。" : state.canDownload ? "看看新变化，准备好后再升级。" : latest ? "美好生活，继续认真记录。" : "有新版本时会提醒你，升级时间由你决定。";
        TextView heading = text(title, 25, MobileStyle.INK, true); if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true); content.addView(heading); gap(content, 9); content.addView(text(subtitle, 13, MobileStyle.MUTED, false)); gap(content, 22); versionStrip(content, state);
        if (confirmInstall) {
            gap(content, 20); content.addView(text("原来的账本，会好好保留", 16, MobileStyle.INK, true)); gap(content, 8); content.addView(text("升级沿用现有账本与设置，无需卸载。安卓仍会请你确认安装权限及覆盖安装。", 13, MobileStyle.MUTED, false));
        } else if (checking || installing) {
            gap(content, 24); ProgressBar spinner = new ProgressBar(activity); spinner.setIndeterminateTintList(ColorStateList.valueOf(MobileStyle.ACCENT)); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(30), dp(30)); params.gravity = Gravity.CENTER_HORIZONTAL; content.addView(spinner, params); gap(content, 15);
        } else if (downloading) {
            gap(content, 20); progressLabel = text("", 13, MobileStyle.ACCENT, true); content.addView(progressLabel);
            progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(100); progress.setProgressTintList(ColorStateList.valueOf(MobileStyle.ACCENT)); progress.setIndeterminateTintList(ColorStateList.valueOf(MobileStyle.ACCENT)); progress.setProgressBackgroundTintList(ColorStateList.valueOf(MobileStyle.SOFT));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(8)); params.topMargin = dp(11); params.bottomMargin = dp(10); content.addView(progress, params); patchProgress(state);
        } else if (state.canDownload || state.canInstall) notes(content, state);
        if (!confirmInstall && !state.message.isEmpty() && !installing) {
            gap(content, 14); content.addView(text(state.message, 12, MobileStyle.MUTED, false));
        }
        if (!localError.isEmpty()) { gap(content, 14); TextView error = text(localError, 13, 0xFFAD595F, false); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(error); }
        if (latest && state.checkedAt > 0) { gap(content, 8); content.addView(text("上次检查 " + new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date(state.checkedAt)), 12, MobileStyle.MUTED, false)); }
        gap(content, 20); line(content); gap(content, 14);
        LinearLayout retention = row(); retention.addView(MobileIcons.view(activity, "shield", MobileStyle.MUTED, 15), new LinearLayout.LayoutParams(dp(15), dp(15)));
        TextView retained = text("覆盖升级，保留账本与设置", 11, MobileStyle.MUTED, false); retained.setPadding(dp(7), 0, 0, 0); retention.addView(retained, new LinearLayout.LayoutParams(0, -2, 1)); content.addView(retention);
        if (confirmInstall) {
            addButton(content, "继续安装", true, "confirm", this::confirm); addButton(content, "再等一下", false, "back", () -> { confirmInstall = false; render(updater.snapshot()); });
        } else if (checking || installing) addButton(content, checking ? "后台检查" : "知道了", false, "close", this::dismiss);
        else if (downloading) {
            addButton(content, "后台下载", true, "background", this::dismiss);
            Button cancel = button(cancelRequested ? "正在取消…" : "取消下载", false, "cancel", () -> { cancelRequested = true; updater.cancelDownload(); refresh(); }); cancel.setEnabled(!cancelRequested); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(10); content.addView(cancel, params);
            browserFallback(content);
        } else if (state.canInstall) {
            addButton(content, "准备安装", true, "install", this::install); addButton(content, "稍后安装", false, "close", this::dismiss);
        } else if (state.canDownload) {
            addButton(content, "下载更新", true, "download", this::startDownload);
            if (state.message.startsWith("检查更新未完成")) addButton(content, "重新检查", false, "check", this::check);
            addButton(content, "稍后提醒", false, "close", this::dismiss);
            browserFallback(content);
        } else {
            if (!latest) addButton(content, "检查更新", true, "check", this::check);
            addButton(content, latest ? "继续记账" : "稍后再说", latest, "close", this::dismiss);
        }
        scroll = new BoundedScrollView(activity); scroll.setFillViewport(false); scroll.setClipToPadding(false); scroll.setVerticalScrollBarEnabled(false); scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        scroll.setBackground(MobileStyle.surface(activity, Color.WHITE, 24)); scroll.setClipToOutline(true); dialog.setContentView(scroll);
        final ScrollView rendered = scroll;
        rendered.post(() -> { if (scroll == rendered && !disposed) { rendered.scrollTo(0, oldScroll); if (focusTag != null) { View target = rendered.findViewWithTag(focusTag); if (target != null) target.requestFocus(); } } });
    }
    private final class BoundedScrollView extends ScrollView {
        BoundedScrollView(Context context) { super(context); }
        @Override protected void onMeasure(int width, int height) {
            Rect visible = new Rect(); activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
            int screenHeight = visible.height() > 0 ? visible.height() : getResources().getDisplayMetrics().heightPixels;
            int limit = Math.max(dp(120), Math.min(dp(740), screenHeight - dp(40)));
            super.onMeasure(width, MeasureSpec.makeMeasureSpec(limit, MeasureSpec.AT_MOST));
        }
    }
}
