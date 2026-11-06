package com.moneylab.superledger.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Small presentation helpers; no network, installer or ledger access. */
public final class UpdatePresentation {
    private UpdatePresentation() {}

    public static String bytes(long value) {
        if (value <= 0) return "0 B";
        if (value < 1024) return value + " B";
        if (value < 1024L * 1024) return String.format(Locale.CHINA, "%.1f KB", value / 1024.0);
        return String.format(Locale.CHINA, "%.1f MB", value / 1048576.0);
    }

    public static int percent(long downloaded, long total) {
        if (total <= 0 || downloaded <= 0) return 0;
        return (int) Math.min(100, Math.floor((double) downloaded / total * 100));
    }

    public static List<String> highlights(String notes) {
        List<String> result = new ArrayList<>();
        if (notes == null) return result;
        for (String line : notes.replace('\r', '\n').split("\\n+")) {
            String value = line.trim().replaceFirst("^(?:#{1,6}\\s+|[-*•]\\s+|[0-9]+[.)、]\\s*)", "").replace("**", "").trim();
            if (value.isEmpty() || value.matches("(?i)^(?:Windows\\b|Android\\b|版本[：:]|验证[：:]|下载前|先更新电脑|安装说明[：:]).*") || value.matches("^更新说明[：:]?$")) continue;
            int stop = -1;
            for (int i = 0; i < value.length(); i++) {
                if ("。！？".indexOf(value.charAt(i)) >= 0) { stop = i + 1; break; }
            }
            if (stop > 0) value = value.substring(0, stop);
            if (value.codePointCount(0, value.length()) > 88) value = value.substring(0, value.offsetByCodePoints(0, 87)) + "…";
            result.add(value);
            if (result.size() == 3) break;
        }
        return result;
    }
}
