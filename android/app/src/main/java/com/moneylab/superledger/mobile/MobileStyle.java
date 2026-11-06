package com.moneylab.superledger.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.Button;

/** Shared native presentation tokens; no ledger or preference state lives here. */
public final class MobileStyle {
    public static final int BG = 0xFFF7F8FC, INK = 0xFF20233B, MUTED = 0xFF798096;
    public static final int ACCENT = 0xFF6B5CF0, LINE = 0xFFE9ECF4, SOFT = 0xFFEFEDFF;
    public static final int GREEN = 0xFF168C79, CORAL = 0xFFED987E;
    private MobileStyle() {}

    public static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
    public static GradientDrawable surface(Context context, int color, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color); drawable.setCornerRadius(dp(context, radiusDp)); return drawable;
    }
    public static GradientDrawable outlined(Context context, int color, int strokeColor, float radiusDp) {
        GradientDrawable drawable = surface(context, color, radiusDp);
        drawable.setStroke(Math.max(1, dp(context, 1)), strokeColor); return drawable;
    }
    public static RippleDrawable ripple(Context context, int color, float radiusDp) {
        int ink = color == ACCENT ? 0x35FFFFFF : 0x226B5CF0;
        return new RippleDrawable(ColorStateList.valueOf(ink), surface(context, color, radiusDp), surface(context, Color.WHITE, radiusDp));
    }
    /** Call after showing a standard Android dialog, when its action buttons exist. */
    public static void styleDialog(AlertDialog dialog) {
        Context context = dialog.getContext();
        if (dialog.getWindow() != null) dialog.getWindow().setBackgroundDrawable(outlined(context, Color.WHITE, LINE, 24));
        for (int which : new int[]{AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL}) {
            Button button = dialog.getButton(which);
            if (button == null) continue;
            button.setAllCaps(false); button.setTextColor(which == AlertDialog.BUTTON_POSITIVE ? ACCENT : MUTED);
            button.setTextSize(14); button.setMinHeight(dp(context, 48)); button.setMinimumHeight(dp(context, 48));
        }
    }
}
