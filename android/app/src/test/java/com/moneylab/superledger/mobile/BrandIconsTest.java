package com.moneylab.superledger.mobile;

import org.json.JSONObject;

/** Host regression against compiled production color policy, with no Android UI runtime. */
public final class BrandIconsTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static double channel(int value){double c=value/255.0;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
    private static double whiteContrast(int color){double luminance=.2126*channel(color>>16&255)+.7152*channel(color>>8&255)+.0722*channel(color&255);return 1.05/(luminance+.05);}
    public static void main(String[] args)throws Exception {
        int white=0xFFFFFFFF,brand=BrandIcons.logoBackground("ttvoice",white,true),paused=BrandIcons.logoBackground("ttvoice",white,false);
        check(brand==0xFF5E69F5,"active TT keeps the same purple surface as its native list logo");
        check(paused==MobileStyle.MUTED&&paused!=brand,"paused TT uses the shared muted gray surface");
        check(whiteContrast(brand)>=3&&whiteContrast(paused)>=3,"white TT artwork retains at least 3:1 graphic contrast in both states");
        check(BrandIcons.logoBackground("chatgpt",white,true)==white&&BrandIcons.logoBackground("chatgpt",white,false)==white,"other service logo surfaces remain unchanged");
        check(BrandIcons.logoBackground("",0xFF123456,true)==0xFF123456,"custom logo fallback retains its chosen background");
        String explicit=BrandIcons.forSubscription(new JSONObject().put("serviceId","ttvoice").put("name","Custom name"));
        String legacy=BrandIcons.forSubscription(new JSONObject().put("name","TT语音 超级玩家"));
        check(BrandIcons.logoBackground(explicit,white,true)==brand&&BrandIcons.logoBackground(legacy,white,true)==brand,"both explicit and legacy-resolved TT logo keys receive the same contrasting background");
        System.out.println("BrandIcons: "+checks+" production background and graphic contrast checks passed (no Android UI runtime)");
    }
}
