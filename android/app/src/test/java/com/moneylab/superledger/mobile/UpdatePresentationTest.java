package com.moneylab.superledger.mobile;

import java.util.List;

public final class UpdatePresentationTest {
    private static int checks;
    private static void equal(Object expected, Object actual) { checks++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", received " + actual); }
    public static void main(String[] args) {
        equal("0 B", UpdatePresentation.bytes(-1)); equal("1023 B", UpdatePresentation.bytes(1023));
        equal("1.0 KB", UpdatePresentation.bytes(1024)); equal("1.5 MB", UpdatePresentation.bytes(1572864));
        equal(0, UpdatePresentation.percent(1, 0)); equal(100, UpdatePresentation.percent(Long.MAX_VALUE, 1)); equal(42, UpdatePresentation.percent(42, 100));
        String notes = "Windows 1.8.0 / Android 1.3.0\n\n# 更新说明\n\n- 界面清爽了。还有更多细节。\n\n**首页更好读。**\n\n3. 更新窗口更清楚。\n\n验证：不属于亮点。\n下载前验证签名。";
        List<String> highlights = UpdatePresentation.highlights(notes);
        equal(3, highlights.size()); equal("界面清爽了。", highlights.get(0)); equal("首页更好读。", highlights.get(1)); equal("更新窗口更清楚。", highlights.get(2));
        equal(0, UpdatePresentation.highlights("Android 1.3.0\n验证：测试通过\n安装说明：覆盖安装\n更新说明：").size());
        StringBuilder longText = new StringBuilder(); for (int i = 0; i < 100; i++) longText.append("\uD83C\uDF31");
        String clipped = UpdatePresentation.highlights(longText.toString()).get(0);
        equal(88, clipped.codePointCount(0, clipped.length())); equal("…", clipped.substring(clipped.length() - 1));
        equal("<img src=x onerror=alert(1)>", UpdatePresentation.highlights("<img src=x onerror=alert(1)>").get(0));
        equal(0, UpdatePresentation.highlights(null).size());
        System.out.println("UpdatePresentationTest: " + checks + " assertions passed");
    }
}
