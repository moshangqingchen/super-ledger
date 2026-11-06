package com.moneylab.superledger.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/** Small, consistent line glyphs for native controls, drawn in a 24-unit grid. */
public final class MobileIcons {
    private MobileIcons() {}
    public static View view(Context context, String name, int color, int sizeDp) {
        return new Glyph(context, name, color, sizeDp);
    }
    private static final class Glyph extends View {
        private final String name;
        private final int desired;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Glyph(Context context, String name, int color, int sizeDp) {
            super(context); this.name = name == null ? "" : name; desired = MobileStyle.dp(context, sizeDp);
            paint.setColor(color); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(1.7f);
            paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); setFocusable(false);
        }
        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            setMeasuredDimension(resolveSize(desired, widthSpec), resolveSize(desired, heightSpec));
        }
        private void lines(Canvas canvas, float... points) {
            Path path = new Path(); path.moveTo(points[0], points[1]);
            for (int i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
            canvas.drawPath(path, paint);
        }
        private void box(Canvas canvas, float left, float top, float right, float bottom, float radius) {
            canvas.drawRoundRect(new RectF(left, top, right, bottom), radius, radius, paint);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); float unit = Math.min(getWidth(), getHeight()) / 24f;
            canvas.save(); canvas.translate((getWidth() - unit * 24) / 2, (getHeight() - unit * 24) / 2); canvas.scale(unit, unit);
            switch (name) {
                case "home": case "overview": case "grid":
                    box(canvas, 3, 3, 9, 10, 1.5f); box(canvas, 15, 3, 21, 8, 1.5f);
                    box(canvas, 3, 16, 9, 21, 1.5f); box(canvas, 15, 14, 21, 21, 1.5f); break;
                case "ledger": case "list": case "receipt":
                    lines(canvas, 5, 3, 19, 3, 19, 22, 15.5f, 20, 12, 22, 8.5f, 20, 5, 22, 5, 3);
                    lines(canvas, 9, 8, 15, 8); lines(canvas, 9, 12, 15, 12); lines(canvas, 9, 16, 13, 16); break;
                case "wallet": case "accounts":
                    box(canvas, 3, 6, 21, 20, 2); lines(canvas, 4, 6, 4, 4, 18, 4, 18, 6);
                    box(canvas, 15, 11, 21, 16, 1); canvas.drawCircle(17.5f, 13.5f, .4f, paint); break;
                case "more":
                    canvas.drawCircle(5, 12, 1.4f, paint); canvas.drawCircle(12, 12, 1.4f, paint); canvas.drawCircle(19, 12, 1.4f, paint); break;
                case "settings":
                    canvas.drawCircle(12, 12, 3.2f, paint);
                    lines(canvas, 9, 3, 15, 3, 16, 6, 19, 7, 21, 12, 19, 17, 16, 18, 15, 21, 9, 21, 8, 18, 5, 17, 3, 12, 5, 7, 8, 6, 9, 3); break;
                case "sync": case "repeat": case "transfer":
                    lines(canvas, 4, 8, 20, 8, 16, 4); lines(canvas, 20, 16, 4, 16, 8, 20); break;
                case "plus": lines(canvas, 12, 4, 12, 20); lines(canvas, 4, 12, 20, 12); break;
                case "arrow-right": case "right": lines(canvas, 4, 12, 20, 12, 14, 6); lines(canvas, 20, 12, 14, 18); break;
                case "arrow-left": case "back": lines(canvas, 20, 12, 4, 12, 10, 6); lines(canvas, 4, 12, 10, 18); break;
                case "arrow-down": case "down": lines(canvas, 12, 4, 12, 20, 6, 14); lines(canvas, 12, 20, 18, 14); break;
                case "arrow-up": case "up": lines(canvas, 12, 20, 12, 4, 6, 10); lines(canvas, 12, 4, 18, 10); break;
                case "check": lines(canvas, 5, 12, 10, 17, 19, 7); break;
                case "shield":
                    lines(canvas, 12, 2.5f, 20, 6, 19, 14, 16, 19, 12, 22, 8, 19, 5, 14, 4, 6, 12, 2.5f);
                    lines(canvas, 8, 12, 11, 15, 16, 9); break;
                case "goal": case "target":
                    canvas.drawCircle(12, 12, 9, paint); canvas.drawCircle(12, 12, 5.3f, paint); canvas.drawCircle(12, 12, 1.5f, paint); break;
                case "chart": case "insights":
                    lines(canvas, 4, 3, 4, 21, 21, 21); lines(canvas, 9, 16, 9, 11); lines(canvas, 14, 16, 14, 6); lines(canvas, 19, 16, 19, 9); break;
                case "calendar":
                    box(canvas, 3, 5, 21, 21, 2); lines(canvas, 3, 10, 21, 10); lines(canvas, 8, 3, 8, 7); lines(canvas, 16, 3, 16, 7);
                    lines(canvas, 8, 14, 10, 14); lines(canvas, 14, 14, 16, 14); lines(canvas, 8, 18, 10, 18); break;
                case "chevron": case "chevron-right": lines(canvas, 9, 5, 16, 12, 9, 19); break;
                case "chevron-down": lines(canvas, 5, 9, 12, 16, 19, 9); break;
                case "close": lines(canvas, 6, 6, 18, 18); lines(canvas, 18, 6, 6, 18); break;
                case "download":
                    lines(canvas, 12, 3, 12, 15, 7, 10); lines(canvas, 12, 15, 17, 10); lines(canvas, 4, 16, 4, 21, 20, 21, 20, 16); break;
                case "scan":
                    lines(canvas, 3, 8, 3, 3, 8, 3); lines(canvas, 16, 3, 21, 3, 21, 8);
                    lines(canvas, 21, 16, 21, 21, 16, 21); lines(canvas, 8, 21, 3, 21, 3, 16); lines(canvas, 7, 12, 17, 12); break;
                case "phone": box(canvas, 6, 2, 18, 22, 2); lines(canvas, 10, 5, 14, 5); lines(canvas, 11, 19, 13, 19); break;
                case "spark":
                    lines(canvas, 12, 2, 15, 9, 22, 12, 15, 15, 12, 22, 9, 15, 2, 12, 9, 9, 12, 2); break;
                case "info": default:
                    canvas.drawCircle(12, 12, 9, paint); lines(canvas, 12, 11, 12, 17); canvas.drawCircle(12, 7, .3f, paint); break;
            }
            canvas.restore();
        }
    }
}
