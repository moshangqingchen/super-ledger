package com.moneylab.superledger.mobile;

import org.json.JSONObject;

/** Apple balance bookkeeping metadata, kept in step with desktop account-presets.mjs. */
public final class AppleBalance {
    private AppleBalance() {}
    public static final String PROVIDER_ID = "apple-balance";
    public static final String TYPE = "Apple 账户余额";
    public static final String COLOR = "#77728f";

    public static final class Region {
        public final String id, name, currency;
        private Region(String id, String name, String currency) { this.id=id; this.name=name; this.currency=currency; }
    }
    private static final Region[] REGIONS = {
        new Region("US","美国","USD"),
        new Region("TR","土耳其","TRY"),
        new Region("JP","日本","JPY"),
        new Region("CN","中国大陆","CNY"),
        new Region("HK","香港","HKD"),
        new Region("GB","英国","GBP"),
        new Region("CA","加拿大","CAD"),
        new Region("AU","澳大利亚","AUD"),
        new Region("CH","瑞士","CHF"),
        new Region("DE","德国","EUR"),
        new Region("FR","法国","EUR"),
        new Region("IT","意大利","EUR"),
        new Region("ES","西班牙","EUR"),
        new Region("NL","荷兰","EUR"),
        new Region("AT","奥地利","EUR"),
        new Region("BE","比利时","EUR"),
        new Region("IE","爱尔兰","EUR"),
        new Region("PT","葡萄牙","EUR"),
        new Region("FI","芬兰","EUR"),
        new Region("GR","希腊","EUR"),
        new Region("LU","卢森堡","EUR"),
        new Region("OTHER","其他国家 / 地区",null)
    };
    public static Region[] regions() { return REGIONS.clone(); }
    public static Region region(String id) { for(Region region:REGIONS)if(region.id.equals(id))return region;return null; }
    public static boolean isAppleBalance(JSONObject account) { return account!=null&&PROVIDER_ID.equals(account.optString("providerId")); }
    public static String regionLabel(String id) { Region region=region(id);return region==null?"":region.name; }

    /** Distinguishes accounts sharing a nickname across regions or Apple identities. */
    public static String accountLabel(JSONObject account) {
        if(account==null)return "未知账户";
        String name=account.optString("name","未命名账户");
        if(!isAppleBalance(account))return name;
        String region=regionLabel(account.optString("appleRegion")),identity=account.optString("appleAccount");
        return name+(region.isEmpty()?"":" · "+region)+(identity.isEmpty()?"":" · "+identity)+" · "+account.optString("currency","CNY");
    }
    private static String optionalText(JSONObject account,String key,String label,int max)throws Exception {
        if(!account.has(key))return "";
        Object raw=account.opt(key);
        if(!(raw instanceof String))throw new Exception(label+"格式不正确");
        String value=(String)raw;
        if(value.length()>max||value.matches("(?s).*[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F].*"))throw new Exception(label+"格式不正确");
        return value;
    }
    public static void validateAccount(JSONObject account)throws Exception {
        String regionId=optionalText(account,"appleRegion","Apple 账户国家或地区",10);
        String identity=optionalText(account,"appleAccount","Apple 账号标注",160);
        if(isAppleBalance(account)) {
            Region region=region(regionId);
            if(region==null)throw new Exception("请选择 Apple 账户的国家或地区");
            String currency=MobileLedger.currency(account);
            if(region.currency!=null&&!region.currency.equals(currency))throw new Exception("Apple 账户地区与币种不一致，"+region.name+"应使用 "+region.currency);
        } else if(!regionId.isEmpty()||!identity.isEmpty())throw new Exception("只有 Apple 余额账户可以设置 Apple 地区或账号标注");
    }
}
