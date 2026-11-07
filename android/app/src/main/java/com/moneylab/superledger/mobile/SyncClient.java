package com.moneylab.superledger.mobile;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Only literal RFC1918 IPv4 endpoints from a QR code can be contacted. */
public final class SyncClient {
    private SyncClient() {}
    public static final class Pairing {
        public final List<String> addresses = new ArrayList<>();
        public String sessionId;
        public byte[] key;
        public long expiresAt;
        public int protocolVersion;
        public int supportedSchemaVersion = 2;
    }
    private static final int B64 = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;
    public static Pairing parsePairing(String text) throws Exception {
        if (text == null || text.length() > 8192) throw new Exception("这不是有效的超级账本同步二维码");
        JSONObject value;
        try { value = new JSONObject(text.trim()); } catch (Exception e) { throw new Exception("请扫描电脑端「手机同步」中的二维码"); }
        if (!value.optString("app").equals("superledger") || value.optInt("v") != 1) throw new Exception("二维码不属于超级账本，或版本不兼容");
        Pairing result = new Pairing();
        result.protocolVersion = value.optInt("protocolVersion", 1);
        result.supportedSchemaVersion = value.optInt("supportedSchemaVersion", 2);
        if (result.protocolVersion != 2) throw new Exception("完整手机账本需要电脑 1.7.0 或更新版本，请先更新电脑端，再生成新二维码");
        result.sessionId = value.optString("sessionId"); if (!result.sessionId.matches("[a-fA-F0-9]{32}")) throw new Exception("同步会话标识无效");
        String key = value.optString("key"); if (!key.matches("[A-Za-z0-9_-]{43}")) throw new Exception("配对密钥无效");
        result.key = Base64.decode(key, B64); if (result.key.length != 32) throw new Exception("配对密钥长度无效");
        result.expiresAt = value.optLong("expiresAt");
        if (result.expiresAt <= System.currentTimeMillis()) throw new Exception("二维码已过期，请在电脑端刷新后再扫描，并检查手机时间");
        if (result.expiresAt > System.currentTimeMillis() + 24 * 60 * 60 * 1000L) throw new Exception("二维码有效期异常，请检查两端时间并刷新二维码");
        JSONArray endpoints = value.optJSONArray("addresses"); if (endpoints == null || endpoints.length() == 0 || endpoints.length() > 24) throw new Exception("电脑没有可用的局域网地址");
        for (int i = 0; i < endpoints.length(); i++) {
            String endpoint = endpoints.getString(i); URI uri = new URI(endpoint);
            if (!"http".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) || uri.getPort() < 1024 || uri.getPort() > 65535 || !isPrivateIpv4(uri.getHost())) throw new Exception("二维码必须使用本地 Wi-Fi / 热点的私有 IPv4 地址");
            result.addresses.add("http://" + uri.getHost() + ":" + uri.getPort());
        }
        return result;
    }
    public static boolean isPrivateIpv4(String host) {
        if (host == null || !host.matches("[0-9]{1,3}(?:\\.[0-9]{1,3}){3}")) return false;
        String[] segments = host.split("\\."); int[] parts = new int[4];
        for (int i = 0; i < 4; i++) { if (segments[i].length() > 1 && segments[i].startsWith("0")) return false; parts[i] = Integer.parseInt(segments[i]); if (parts[i] > 255) return false; }
        return parts[0] == 10 || (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] == 192 && parts[1] == 168);
    }
    private static JSONObject encrypt(JSONObject plain, Pairing pairing) throws Exception {
        byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(pairing.key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(("superledger-sync-v1:" + pairing.sessionId + ":request").getBytes(StandardCharsets.UTF_8));
        return new JSONObject().put("iv", Base64.encodeToString(iv, B64)).put("data", Base64.encodeToString(cipher.doFinal(plain.toString().getBytes(StandardCharsets.UTF_8)), B64));
    }
    private static JSONObject decrypt(JSONObject envelope, Pairing pairing) throws Exception {
        byte[] iv = Base64.decode(envelope.getString("iv"), B64), payload = Base64.decode(envelope.getString("data"), B64);
        if (iv.length != 12 || payload.length < 16) throw new Exception("同步响应加密格式不正确");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(pairing.key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(("superledger-sync-v1:" + pairing.sessionId + ":response").getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(payload), StandardCharsets.UTF_8));
    }
    public static JSONObject synchronize(Pairing pairing, JSONObject request) throws Exception {
        if (pairing.expiresAt <= System.currentTimeMillis()) throw new Exception("二维码已过期，请在电脑端重新生成并扫码");
        if (request.optInt("schemaVersion", 1) >= 3 && pairing.supportedSchemaVersion < 3)
            throw new Exception("按小时扣账需要电脑 1.8.10 或更新版本，请升级电脑端后重新生成同步二维码");
        byte[] body = encrypt(request, pairing).toString().getBytes(StandardCharsets.UTF_8);
        String lastFailure = "未找到电脑";
        for (String address : pairing.addresses) {
            HttpURLConnection connection = null;
            try {
                // Explicitly local-only. Never consult a proxy, resolve a hostname, or follow redirects.
                connection = (HttpURLConnection) new URL(address + "/sync/v1/" + pairing.sessionId).openConnection(Proxy.NO_PROXY);
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(3500); connection.setReadTimeout(20000); connection.setUseCaches(false);
                connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", "application/json"); connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
                int status = connection.getResponseCode(); if (status >= 300 && status < 400) throw new Exception("同步地址发生重定向，已拒绝连接");
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream(); if (stream == null) throw new Exception("电脑未返回同步结果");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = stream) { byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) >= 0) { bytes.write(buffer, 0, count); if (bytes.size() > 8 * 1024 * 1024) throw new Exception("同步响应超过容量上限"); } }
                JSONObject envelope = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
                if (!envelope.has("iv") || !envelope.has("data")) throw new Exception("电脑未返回加密结果，请刷新电脑二维码后重试");
                JSONObject response = decrypt(envelope, pairing);
                if (!response.optString("requestId").equals(request.getString("requestId"))) throw new Exception("响应不属于本次同步，已拒绝接收");
                if (response.has("error")) throw new AuthenticatedError(response.optString("error", "同步未完成"));
                if (status != 200) throw new AuthenticatedError("电脑未接受同步，请重试");
                if (response.optInt("protocolVersion", 1) != 2) throw new AuthenticatedError("电脑端同步版本过旧，手机记录已保留，请更新电脑端后重试");
                return response;
            } catch (AuthenticatedError error) { throw error; }
            catch (Exception error) { lastFailure = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
            finally { if (connection != null) connection.disconnect(); }
        }
        throw new Exception("未完成同步，手机记录仍保留。请确认同一 Wi-Fi / 热点、电脑同步窗口未关闭，并允许超级账本的局域网连接。\n" + lastFailure);
    }
    private static final class AuthenticatedError extends Exception { AuthenticatedError(String message) { super(message); } }
}
