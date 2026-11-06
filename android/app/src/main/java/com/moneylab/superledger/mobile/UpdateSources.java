package com.moneylab.superledger.mobile;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed public routes. Relays only carry the exact same signed release bytes. */
public final class UpdateSources {
    private UpdateSources() {}
    public static final class Endpoint {
        public final String id, label, url;
        private Endpoint(String id, String label, String url) { this.id = id; this.label = label; this.url = url; }
    }
    private static List<Endpoint> routes(String canonical) {
        List<Endpoint> result = new ArrayList<>();
        result.add(new Endpoint("gh-proxy", "加速源一", "https://gh-proxy.org/" + canonical));
        result.add(new Endpoint("ghfast", "加速源二", "https://ghfast.top/" + canonical));
        result.add(new Endpoint("github", "GitHub 原站", canonical));
        return Collections.unmodifiableList(result);
    }
    private static List<Endpoint> select(List<Endpoint> endpoints, String mode) {
        if (mode == null || "auto".equals(mode)) return endpoints;
        if (!"gh-proxy".equals(mode) && !"ghfast".equals(mode) && !"github".equals(mode)) throw new IllegalArgumentException("更新源选项无效");
        for (Endpoint endpoint : endpoints) if (endpoint.id.equals(mode)) return Collections.singletonList(endpoint);
        throw new IllegalArgumentException("当前版本清单未提供所选更新源，请使用自动选择");
    }
    public static List<Endpoint> manifestEndpoints(String mode) { return select(routes(UpdatePolicy.MANIFEST_URL), mode); }
    public static List<Endpoint> downloadEndpoints(UpdatePolicy.Release release, String mode) {
        if (release == null) throw new IllegalArgumentException("请先验证版本清单");
        return select(release.sources, mode);
    }
    public static List<Endpoint> parseSources(String canonical, JSONArray declared) throws Exception {
        UpdatePolicy.validateDownloadUrl(canonical, true);
        List<Endpoint> allowed = routes(canonical);
        if (declared == null) return allowed;
        if (declared.length() < 1 || declared.length() > allowed.size()) throw new UpdatePolicy.IntegrityException("更新源数量无效");
        List<Endpoint> result = new ArrayList<>(); Set<String> ids = new HashSet<>();
        for (int i = 0; i < declared.length(); i++) {
            JSONObject source = declared.optJSONObject(i);
            if (source == null || !(source.opt("id") instanceof String) || !(source.opt("url") instanceof String)) throw new UpdatePolicy.IntegrityException("更新源字段无效");
            String id = source.getString("id"), url = source.getString("url"); Endpoint match = null;
            for (Endpoint endpoint : allowed) if (endpoint.id.equals(id) && endpoint.url.equals(url)) match = endpoint;
            if (match == null || !ids.add(id)) throw new UpdatePolicy.IntegrityException("更新源不属于已注册的官方文件路线");
            result.add(match);
        }
        return Collections.unmodifiableList(result);
    }
    public static URI validateManifestUrl(String value) throws Exception {
        for (Endpoint endpoint : routes(UpdatePolicy.MANIFEST_URL)) if (endpoint.url.equals(value)) return new URI(value);
        throw new UpdatePolicy.IntegrityException("版本清单来源未注册，已停止连接");
    }
    public static URI validateDownloadUrl(String value, String canonical, boolean initial) throws Exception {
        try { return checkedDownloadUrl(value, canonical, initial); }
        catch (UpdatePolicy.IntegrityException error) { throw error; }
        catch (Exception error) { throw new UpdatePolicy.IntegrityException("安装包地址或跳转不符合已注册来源，已停止连接", error); }
    }
    private static URI checkedDownloadUrl(String value, String canonical, boolean initial) throws Exception {
        UpdatePolicy.validateDownloadUrl(canonical, true);
        for (Endpoint endpoint : routes(canonical)) if (endpoint.url.equals(value)) return new URI(value);
        if (!initial) {
            URI uri = UpdatePolicy.validateDownloadUrl(value, false);
            String host = uri.getHost();
            // An alternate GitHub repository, tag or APK path is never an
            // equivalent source, even when it would pass the legacy host rule.
            if ("release-assets.githubusercontent.com".equalsIgnoreCase(host) || "objects.githubusercontent.com".equalsIgnoreCase(host)) return uri;
        }
        throw new UpdatePolicy.IntegrityException("安装包来源不是已注册的同一版本文件，已停止连接");
    }
}
