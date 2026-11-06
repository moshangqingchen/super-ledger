package com.moneylab.superledger.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
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
    private long lastFrame;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final MultiFormatReader reader = new MultiFormatReader();
    private TextView status;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.BLACK); getWindow().getDecorView().setSystemUiVisibility(0);
        FrameLayout frame = new FrameLayout(this); frame.setBackgroundColor(Color.BLACK);
        preview = new SurfaceView(this); frame.addView(preview, new FrameLayout.LayoutParams(-1, -1)); preview.getHolder().addCallback(this);
        frame.addView(new View(this) { final Paint paint = new Paint(3); @Override protected void onDraw(Canvas canvas) {
            float side = Math.min(getWidth() * .76f, getHeight() * .52f), x = (getWidth() - side) / 2, y = (getHeight() - side) / 2;
            paint.setColor(0x88000000); paint.setStyle(Paint.Style.FILL);
            canvas.drawRect(0, 0, getWidth(), y, paint); canvas.drawRect(0, y + side, getWidth(), getHeight(), paint); canvas.drawRect(0, y, x, y + side, paint); canvas.drawRect(x + side, y, getWidth(), y + side, paint);
            paint.setColor(0xFFC8F286); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(4); canvas.drawRoundRect(new RectF(x, y, x + side, y + side), 18, 18, paint);
        } }, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout controls = new LinearLayout(this); controls.setOrientation(LinearLayout.VERTICAL); controls.setPadding(28, 22, 28, 30);
        status = new TextView(this); status.setText("扫描电脑端「手机同步」二维码\n请让手机和电脑连接同一 Wi-Fi / 热点"); status.setTextColor(Color.WHITE); status.setTextSize(16); status.setGravity(Gravity.CENTER); controls.addView(status);
        Button manual = new Button(this); manual.setText("粘贴配对内容"); manual.setOnClickListener(v -> manual()); controls.addView(manual);
        Button back = new Button(this); back.setText("返回"); back.setOnClickListener(v -> finish()); controls.addView(back);
        FrameLayout.LayoutParams bottom = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM); frame.addView(controls, bottom); setContentView(frame);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class); hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE)); hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE); reader.setHints(hints);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.CAMERA}, 8);
    }
    private void manual() {
        EditText field = new EditText(this); field.setHint("粘贴电脑显示的配对内容"); field.setMinLines(3); field.setMaxLines(7);
        new AlertDialog.Builder(this).setTitle("手动配对").setView(field).setNegativeButton("取消", null).setPositiveButton("连接", (d, w) -> complete(field.getText().toString())).show();
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
    @Override protected void onResume() { super.onResume(); openCamera(); }
    @Override protected void onPause() { releaseCamera(); super.onPause(); }
    @Override protected void onDestroy() { finished = true; decoder.shutdown(); super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) { super.onRequestPermissionsResult(code, permissions, results); if (code == 8 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) openCamera(); else status.setText("相机未授权，仍可粘贴配对内容同步。"); }
}
