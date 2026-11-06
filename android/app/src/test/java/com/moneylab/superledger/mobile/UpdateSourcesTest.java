package com.moneylab.superledger.mobile;

import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exact route matching only: no DNS, sockets, or provider requests. */
public final class UpdateSourcesTest {
    private static int checks;
    private static final String APK = "https://github.com/" + UpdatePolicy.REPOSITORY + "/releases/download/android-v1.3.2/SuperLedger-Mobile-1.3.2.apk";
    private interface Task { void run() throws Exception; }
    private static void check(boolean condition, String label) { checks++; if (!condition) throw new AssertionError(label); }
    private static void rejects(Task action, String label) throws Exception { try { action.run(); throw new AssertionError(label); } catch (Exception expected) { checks++; } }
    private static JSONArray source(String id, String url) throws Exception { return new JSONArray().put(new JSONObject().put("id", id).put("url", url)); }
    public static void main(String[] args) throws Exception {
        List<UpdateSources.Endpoint> defaults = UpdateSources.parseSources(APK, null);
        check(defaults.size() == 3 && defaults.get(0).id.equals("gh-proxy") && defaults.get(1).id.equals("ghfast") && defaults.get(2).id.equals("github"), "stable route preference");
        for (UpdateSources.Endpoint endpoint : defaults) {
            check(UpdateSources.validateDownloadUrl(endpoint.url, APK, true).toString().equals(endpoint.url), "registered initial APK URL accepted");
            check(UpdateSources.validateDownloadUrl(endpoint.url, APK, false).toString().equals(endpoint.url), "registered equivalent redirect accepted");
            check(UpdateSources.parseSources(APK, source(endpoint.id, endpoint.url)).get(0).url.equals(endpoint.url), "signed subset retains exact source");
        }
        rejects(() -> defaults.clear(), "fallback list immutable");
        rejects(() -> UpdateSources.parseSources(APK, new JSONArray()), "empty signed list rejected");
        JSONArray repeated = source("github", APK).put(new JSONObject().put("id", "github").put("url", APK));
        rejects(() -> UpdateSources.parseSources(APK, repeated), "duplicate source rejected");
        rejects(() -> UpdateSources.parseSources(APK, source("ghfast", defaults.get(0).url)), "source ID cannot alias another route");
        rejects(() -> UpdateSources.parseSources(APK, source("unknown", APK)), "unknown source ID rejected");
        rejects(() -> UpdateSources.parseSources(APK, new JSONArray().put("github")), "non-object source rejected");
        rejects(() -> UpdateSources.parseSources(APK, new JSONArray().put(new JSONObject().put("id", 1).put("url", APK))), "non-string source ID rejected");
        String prefix = "https://gh-proxy.org/";
        String[] invalid = {prefix + "https://other.invalid/app.apk", prefix + "https://ghfast.top/" + APK,
            prefix + APK + "?download=1", prefix + APK + "#fragment", prefix.replace("org/", "org.evil.test/") + APK,
            "https://name@gh-proxy.org/" + APK, "https://gh-proxy.org:444/" + APK, "http://gh-proxy.org/" + APK,
            prefix + "../" + APK, prefix + APK.replace("android-v1.3.2", "%2e%2e"), prefix + APK.replace("1.3.2.apk", "1.3.1.apk"),
            APK.replace("1.3.2.apk", "1.3.1.apk"), APK.replace(UpdatePolicy.REPOSITORY, "somebody/other"),
            prefix + UpdatePolicy.MANIFEST_URL, prefix + APK + "\r\nheader: injected"};
        for (String value : invalid) rejects(() -> UpdateSources.validateDownloadUrl(value, APK, false), "unregistered or altered APK route rejected");
        check(UpdateSources.validateDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/123?token=signed", APK, false).getHost().equals("release-assets.githubusercontent.com"), "GitHub signed asset query remains supported after redirect");
        rejects(() -> UpdateSources.validateDownloadUrl("https://release-assets.githubusercontent.com/asset", APK, true), "asset host cannot replace initial repository path");
        List<UpdateSources.Endpoint> manifests = UpdateSources.manifestEndpoints("auto"); check(manifests.size() == 3, "manifest has same three choices");
        for (UpdateSources.Endpoint endpoint : manifests) { check(UpdateSources.validateManifestUrl(endpoint.url).toString().equals(endpoint.url), "fixed manifest route accepted"); check(UpdateSources.manifestEndpoints(endpoint.id).size() == 1, "manual route does not silently add another provider"); }
        rejects(() -> UpdateSources.validateManifestUrl(manifests.get(0).url + "?refresh=1"), "manifest query injection rejected");
        rejects(() -> UpdateSources.validateManifestUrl(manifests.get(0).url.replace("main/", "other/")), "manifest branch cannot change");
        rejects(() -> UpdateSources.validateManifestUrl(defaults.get(0).url), "APK endpoint cannot become manifest source");
        rejects(() -> UpdateSources.manifestEndpoints("unknown"), "unknown selection rejected");
        System.out.println("UpdateSources: " + checks + " offline checks passed (no network)");
    }
}
