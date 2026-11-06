package com.moneylab.superledger.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.HybridBinarizer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private SurfaceView preview;
    private Camera camera;
    private boolean surfaceReady, finished, decoding;
    private boolean awaitingCameraPermission;
    private final UpdatePolicy.OpenLifecycle updateOpen = new UpdatePolicy.OpenLifecycle(false);
    private AppUpdater updater;
    private long lastFrame;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final MultiFormatReader reader = new MultiFormatReader();
    private TextView status;
    private int dp(float value) { return MobileStyle.dp(this, value); }
    private TextView copy(String value, int size, int color, boolean bold) {
        TextView text = new TextView(this); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        text.setLineSpacing(dp(3), 1); if (bold) text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); return text;
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        updater = AppUpdater.get(this);
        awaitingCameraPermission = saved != null && saved.getBoolean("awaitingCameraPermission", false);
        getWindow().setStatusBarColor(MobileStyle.BG); getWindow().setNavigationBarColor(MobileStyle.BG);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(MobileStyle.BG);
        root.setOnApplyWindowInsetsListener((v, insets) -> { v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(16), dp(10), dp(20), dp(14));
        FrameLayout back = new FrameLayout(this); back.setBackground(MobileStyle.ripple(this, Color.WHITE, 15)); back.setContentDescription("返回账本"); back.setFocusable(true); back.setOnClickListener(v -> finish());
        back.addView(MobileIcons.view(this, "arrow-left", MobileStyle.INK, 22), new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER)); header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout titles = new LinearLayout(this); titles.setOrientation(LinearLayout.VERTICAL); titles.setPadding(dp(12), 0, 0, 0);
        titles.addView(copy("扫码同步", 21, MobileStyle.INK, true)); titles.addView(copy("手机与电脑，一本账", 12, MobileStyle.MUTED, false)); header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(20), 0, dp(20), dp(24)); scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        FrameLayout frame = new FrameLayout(this); frame.setBackground(MobileStyle.surface(this, 0xFF20233B, 24)); frame.setClipToOutline(true);
        preview = new SurfaceView(this); frame.addView(preview, new FrameLayout.LayoutParams(-1, -1)); preview.getHolder().addCallback(this);
        preview.setContentDescription("相机取景区域，请对准电脑端配对二维码");
        frame.addView(new View(this) { final Paint paint = new Paint(3); @Override protected void onDraw(Canvas canvas) {
            float side = Math.min(getWidth() * .78f, getHeight() * .74f), x = (getWidth() - side) / 2, y = (getHeight() - side) / 2;
            paint.setColor(0x8020233B); paint.setStyle(Paint.Style.FILL);
            canvas.drawRect(0, 0, getWidth(), y, paint); canvas.drawRect(0, y + side, getWidth(), getHeight(), paint); canvas.drawRect(0, y, x, y + side, paint); canvas.drawRect(x + side, y, getWidth(), y + side, paint);
            paint.setColor(0x66FFFFFF); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1)); canvas.drawRoundRect(new RectF(x, y, x + side, y + side), dp(12), dp(12), paint);
            paint.setColor(0xFFC5BDFF); paint.setStrokeWidth(dp(3)); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            float arm = dp(27), endX = x + side, endY = y + side; Path corners = new Path();
            corners.moveTo(x, y + arm); corners.lineTo(x, y + dp(8)); corners.quadTo(x, y, x + dp(8), y); corners.lineTo(x + arm, y);
            corners.moveTo(endX - arm, y); corners.lineTo(endX - dp(8), y); corners.quadTo(endX, y, endX, y + dp(8)); corners.lineTo(endX, y + arm);
            corners.moveTo(endX, endY - arm); corners.lineTo(endX, endY - dp(8)); corners.quadTo(endX, endY, endX - dp(8), endY); corners.lineTo(endX - arm, endY);
            corners.moveTo(x + arm, endY); corners.lineTo(x + dp(8), endY); corners.quadTo(x, endY, x, endY - dp(8)); corners.lineTo(x, endY - arm); canvas.drawPath(corners, paint);
        } }, new FrameLayout.LayoutParams(-1, -1));
        int cameraHeight = Math.max(dp(220), Math.min(dp(380), Math.round(getResources().getDisplayMetrics().heightPixels * .43f)));
        content.addView(frame, new LinearLayout.LayoutParams(-1, cameraHeight));
        LinearLayout controls = new LinearLayout(this); controls.setOrientation(LinearLayout.VERTICAL); controls.setPadding(dp(20), dp(20), dp(20), dp(20)); controls.setBackground(MobileStyle.outlined(this, Color.WHITE, MobileStyle.LINE, 22));
        LinearLayout caption = new LinearLayout(this); caption.setGravity(Gravity.CENTER_VERTICAL);
        caption.addView(MobileIcons.view(this, "scan", MobileStyle.ACCENT, 22), new LinearLayout.LayoutParams(dp(22), dp(22)));
        TextView title = copy("对准电脑上的二维码", 17, MobileStyle.INK, true); LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, -2, 1); titleParams.leftMargin = dp(9); caption.addView(title, titleParams); controls.addView(caption);
        TextView help = copy("电脑端打开「手机同步」，将二维码放入取景框。", 14, MobileStyle.MUTED, false); help.setPadding(0, dp(12), 0, dp(8)); controls.addView(help);
        status = copy("手机与电脑需连接同一 Wi-Fi 或手机热点。", 13, MobileStyle.MUTED, false); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); controls.addView(status);
        Button manual = new Button(this); manual.setText("粘贴配对内容"); manual.setAllCaps(false); manual.setTextSize(14); manual.setTextColor(MobileStyle.ACCENT); manual.setBackground(MobileStyle.ripple(this, MobileStyle.SOFT, 14)); manual.setMinHeight(dp(48)); manual.setMinimumHeight(dp(48)); manual.setPadding(dp(14), dp(12), dp(14), dp(12)); manual.setElevation(0); manual.setOnClickListener(v -> manual());
        LinearLayout.LayoutParams manualParams = new LinearLayout.LayoutParams(-1, -2); manualParams.topMargin = dp(18); controls.addView(manual, manualParams);
        LinearLayout.LayoutParams panelParams = new LinearLayout.LayoutParams(-1, -2); panelParams.topMargin = dp(18); content.addView(controls, panelParams);
        TextView footer = copy("本地连接 · 加密同步", 12, MobileStyle.MUTED, false); footer.setGravity(Gravity.CENTER); footer.setPadding(0, dp(18), 0, 0); content.addView(footer);
        setContentView(root); root.requestApplyInsets();
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class); hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE)); hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE); reader.setHints(hints);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED && !awaitingCameraPermission) {
            awaitingCameraPermission = true;
            try { requestPermissions(new String[]{Manifest.permission.CAMERA}, 8); }
            catch (RuntimeException error) { awaitingCameraPermission = false; throw error; }
        }
    }
    private void manual() {
        LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(22), dp(8), dp(22), dp(8));
        EditText field = new EditText(this); field.setHint("粘贴电脑显示的配对内容"); field.setMinLines(3); field.setMaxLines(7); field.setTextSize(15); field.setTextColor(MobileStyle.INK); field.setHintTextColor(MobileStyle.MUTED); field.setGravity(Gravity.TOP); field.setPadding(dp(12), dp(12), dp(12), dp(12)); field.setBackground(MobileStyle.outlined(this, MobileStyle.BG, MobileStyle.LINE, 12)); form.addView(field, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("粘贴配对内容").setView(form).setNegativeButton("取消", null).setPositiveButton("连接", (d, w) -> complete(field.getText().toString())).show();
        MobileStyle.styleDialog(dialog);
    }
    private void complete(String value) {
        if (finished) return;
        try { SyncClient.parsePairing(value); finished = true; releaseCamera(); setResult(RESULT_OK, new Intent().putExtra("pairing", value)); finish(); }
        catch (Exception e) { status.setText(e.getMessage()); }
    }
    private void openCamera() {
        if (!surfaceReady || camera != null || finished || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            camera = Camera.open(); Camera.Parameters parameters = camera.getParameters();
            Camera.Size best = parameters.getSupportedPreviewSizes().get(0);
            for (Camera.Size size : parameters.getSupportedPreviewSizes()) if (size.width <= 1280 && Math.abs(size.width - 1280) < Math.abs(best.width - 1280)) best = size;
            parameters.setPreviewSize(best.width, best.height);
            if (parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters); camera.setDisplayOrientation(90); camera.setPreviewDisplay(preview.getHolder()); camera.setPreviewCallback(this); camera.startPreview();
        } catch (Exception e) { releaseCamera(); status.setText("无法打开相机，可使用「粘贴配对内容」。请在应用设置中允许相机权限。"); }
    }
    @Override public void onPreviewFrame(byte[] data, Camera source) {
        if (decoding || finished || System.currentTimeMillis() - lastFrame < 400) return;
        lastFrame = System.currentTimeMillis(); decoding = true; Camera.Size size = source.getParameters().getPreviewSize(); byte[] copy = data.clone();
        decoder.execute(() -> {
            try {
                PlanarYUVLuminanceSource image = new PlanarYUVLuminanceSource(copy, size.width, size.height, 0, 0, size.width, size.height, false);
                Result result = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(image)));
                runOnUiThread(() -> complete(result.getText()));
            } catch (Exception ignored) {} finally { reader.reset(); decoding = false; }
        });
    }
    private void releaseCamera() { if (camera != null) { try { camera.setPreviewCallback(null); camera.stopPreview(); camera.release(); } catch (Exception ignored) {} camera = null; } }
    @Override public void surfaceCreated(SurfaceHolder holder) { surfaceReady = true; openCamera(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
    @Override public void surfaceDestroyed(SurfaceHolder holder) { surfaceReady = false; releaseCamera(); }
    @Override protected void onStart() { super.onStart(); updater.onSecondaryActivityStarted(updateOpen.onStart()); }
    @Override protected void onStop() { updateOpen.onStop(isChangingConfigurations() || isFinishing() || awaitingCameraPermission); super.onStop(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); out.putBoolean("awaitingCameraPermission", awaitingCameraPermission); }
    @Override protected void onResume() { super.onResume(); openCamera(); }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (focused) awaitingCameraPermission = false; }
    @Override protected void onPause() { releaseCamera(); super.onPause(); }
    @Override protected void onDestroy() { finished = true; decoder.shutdown(); super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) { super.onRequestPermissionsResult(code, permissions, results); if (code == 8) awaitingCameraPermission = false; if (code == 8 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) openCamera(); else status.setText("相机未授权，仍可粘贴配对内容同步。"); }
}
