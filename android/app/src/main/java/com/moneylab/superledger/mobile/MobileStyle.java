package com.moneylab.superledger.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.view.View;
import android.widget.Button;

/** Shared native presentation tokens; no ledger or preference state lives here. */
public final class MobileStyle {
    public static final int BG = 0xFFF6F7FB, INK = 0xFF29364E, MUTED = 0xFF76839B;
    public static final int ACCENT = 0xFF7D69B6, LINE = 0xFFE5EAF3, SOFT = 0xFFF0ECF9;
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
    /** A small tint, not a full-bleed illustration: text stays on a light surface. */
    public static GradientDrawable material(Context context, int tint, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{Color.WHITE, blend(Color.WHITE, tint, .025f), blend(Color.WHITE, tint, .10f)});
        drawable.setCornerRadius(dp(context, radiusDp));
        drawable.setStroke(Math.max(1, dp(context, 1)), blend(Color.WHITE, tint, .16f));
        return drawable;
    }
    public static GradientDrawable heroSurface(Context context) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xFFF0EAFB, 0xFFF7F5FD, 0xFFF5F9FD});
        drawable.setCornerRadius(dp(context, 22));
        drawable.setStroke(Math.max(1, dp(context, 1)), 0xFFE4DDF3);
        return drawable;
    }
    public static int blend(int base, int tint, float proportion) {
        float p = Math.max(0, Math.min(1, proportion));
        return Color.argb(Math.round(Color.alpha(base) * (1 - p) + Color.alpha(tint) * p),
                Math.round(Color.red(base) * (1 - p) + Color.red(tint) * p),
                Math.round(Color.green(base) * (1 - p) + Color.green(tint) * p),
                Math.round(Color.blue(base) * (1 - p) + Color.blue(tint) * p));
    }
    public static void softElevation(View view, float elevationDp) {
        view.setElevation(dp(view.getContext(), elevationDp));
        if (Build.VERSION.SDK_INT >= 28) {
            view.setOutlineAmbientShadowColor(0x182B3854);
            view.setOutlineSpotShadowColor(0x202B3854);
        }
    }
    public static RippleDrawable buttonBackground(Context context, boolean primary) {
        GradientDrawable content = primary
                ? new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                    new int[]{blend(ACCENT, Color.WHITE, .12f), ACCENT, blend(ACCENT, INK, .07f)})
                : new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.WHITE, SOFT});
        content.setCornerRadius(dp(context, 14));
        content.setStroke(Math.max(1, dp(context, 1)), primary ? blend(ACCENT, Color.WHITE, .28f) : 0xFFE3DDED);
        return new RippleDrawable(ColorStateList.valueOf(primary ? 0x30FFFFFF : 0x187D69B6),
                content, surface(context, Color.WHITE, 14));
    }
    public static RippleDrawable cardRipple(Context context, int tint, float radiusDp) {
        return new RippleDrawable(ColorStateList.valueOf(0x147D69B6), material(context, tint, radiusDp),
                surface(context, Color.WHITE, radiusDp));
    }
    public static StateListDrawable inputSurface(Context context) {
        StateListDrawable drawable = new StateListDrawable();
        drawable.addState(new int[]{android.R.attr.state_focused}, outlined(context, Color.WHITE, 0xFFB9A9D8, 12));
        drawable.addState(new int[]{android.R.attr.state_pressed}, outlined(context, Color.WHITE, 0xFFC9BEDF, 12));
        drawable.addState(new int[]{}, outlined(context, 0xFFFCFDFF, LINE, 12));
        return drawable;
    }
    public static RippleDrawable ripple(Context context, int color, float radiusDp) {
        int ink = color == ACCENT ? 0x35FFFFFF : 0x187D69B6;
        return new RippleDrawable(ColorStateList.valueOf(ink), surface(context, color, radiusDp), surface(context, Color.WHITE, radiusDp));
    }
    /** Call after showing a standard Android dialog, when its action buttons exist. */
    public static void styleDialog(AlertDialog dialog) {
        Context context = dialog.getContext();
        if (dialog.getWindow() != null) dialog.getWindow().setBackgroundDrawable(material(context, 0xFF9AABC7, 24));
        for (int which : new int[]{AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL}) {
            Button button = dialog.getButton(which);
            if (button == null) continue;
            button.setAllCaps(false); button.setTextColor(which == AlertDialog.BUTTON_POSITIVE ? ACCENT : MUTED);
            button.setTextSize(14); button.setMinHeight(dp(context, 48)); button.setMinimumHeight(dp(context, 48));
            button.setBackground(ripple(context, Color.TRANSPARENT, 10));
        }
    }
}
