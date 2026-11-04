package com.xingji.host;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.*;
import android.util.Base64;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.*;
import java.io.*;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.system.ErrnoException;
import org.json.JSONObject;

/** Exact, main-frame native boundary. SDK plugin execution stays on Bridge's serial queue.
 * MessageHandler has no safe public constructor: it can add a legacy JS interface. Instead
 * public PluginCall/Bridge.callPluginMethod carry replies over an origin-bound reply proxy.
 * No persisted address grants authority, no reflection, no SDK private-field mutation.
 */
@CapacitorPlugin(name = "XingjiHost")
public class XingjiHostPlugin extends Plugin {
    private static final String PREFS = "xingji_host";
    private static final String KEY_MARKER_PREFIX = "marker_";
    private volatile String trustedOrigin;
    private volatile String localOrigin;
    /** Main-thread snapshot of the top frame's origin (onPageStarted/onPageFinished). */
    private volatile String currentOrigin;
    private volatile long epoch;
    private volatile boolean boundaryReady;
    private boolean enteringRemote;
    private androidx.webkit.ScriptHandler remoteScript;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String originOf(String raw) {
        try {
            java.net.URI uri = java.net.URI.create(raw);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if ((!scheme.equals("http") && !scheme.equals("https")) || uri.getUserInfo() != null) return null;
            int port = uri.getPort();
            if (port < -1 || port == 0 || port > 65535) return null;
            boolean standard = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
            return scheme + "://" + host + (standard ? "" : ":" + port);
        } catch (Exception e) { return null; }
    }

    private static String normalizeOrigin(String raw) {
        if (raw == null) return null;
        try {
            java.net.URI uri = java.net.URI.create(raw.trim());
            if ((uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")) || uri.getQuery() != null || uri.getFragment() != null) return null;
            return originOf(raw.trim());
        } catch (Exception e) { return null; }
    }

    private boolean permits(String origin) {
        return origin != null && (origin.equals(localOrigin) || origin.equals(trustedOrigin));
    }

    /**
     * Gate for every plugin method. The caller is whatever page the WebView currently
     * shows — an unforgeable fact from the embedder. Its origin must be the local
     * package page or the granted trusted origin, and the boundary must be live.
     * After revocation trustedOrigin is null, so a page left at the old remote origin
     * no longer matches. Plugin calls arrive over the standard Capacitor bridge; there
     * is no WebMessageListener and therefore no wildcard origin rule.
     */
    private boolean authorized(PluginCall call) {
        if (!boundaryReady) return false;
        // currentOrigin is maintained on the main thread by the WebViewClient callbacks
        // (onPageStarted/onPageFinished) — WebView.getUrl() itself must not be called
        // from the CapacitorPlugins thread (throws "WebView method on wrong thread").
        return permits(currentOrigin);
    }

    @Override public void load() {
        // BridgeWebChromeClient/BridgeWebViewClient constructors register ActivityResult
        // launchers: they MUST be built synchronously in load() (before STARTED), never
        // deferred via webView.post — posting crashed with "register while RESUMED".
        installBoundary();
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                WebView view = getBridge().getWebView();
                final boolean[] finished = {false};
                Runnable fallback = () -> {
                    if (finished[0]) return;
                    finished[0] = true;
                    // This is a single-activity SPA. Root Back backgrounds it, preserving
                    // the WebView and its in-flight native transactions for resume.
                    if (boundaryReady && trustedOrigin != null && trustedOrigin.equals(currentOrigin)
                        && getActivity().moveTaskToBack(true)) return;
                    setEnabled(false);
                    try { getActivity().getOnBackPressedDispatcher().onBackPressed(); }
                    finally { setEnabled(true); }
                };
                if (!boundaryReady || trustedOrigin == null || !trustedOrigin.equals(currentOrigin)) {
                    fallback.run();
                    return;
                }
                // Fail open to system Back if the renderer is unresponsive; never trap the user.
                view.postDelayed(fallback, 1500);
                view.evaluateJavascript("document.dispatchEvent(new Event('xingji:native-back',{cancelable:true}))", value -> {
                    view.removeCallbacks(fallback);
                    if ("false".equals(value)) finished[0] = true;
                    else fallback.run();
                });
            }
        });
    }

    private void installBoundary() {
        WebView view = getBridge().getWebView();
        localOrigin = originOf(getBridge().getLocalUrl());
        prefs().edit().remove("trusted_origin").apply();
        // DO NOT removeJavascriptInterface("androidBridge"): that interface IS the
        // Capacitor 8 native bridge channel (verified: removing it kills the bridge
        // bootstrap and window.Capacitor degrades to the web implementation).
        boundaryReady = localOrigin != null && !getBridge().getConfig().isUsingLegacyBridge()
            && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                String target = originOf(request.getUrl().toString());
                if (target != null && target.equals(localOrigin)) {
                    // Only navigateToLocal may destroy a remote realm; JS drains first.
                    return !localOrigin.equals(originOf(webView.getUrl()));
                }
                if (boundaryReady && target != null && target.equals(trustedOrigin)
                    && (enteringRemote || localOrigin.equals(originOf(webView.getUrl()))
                        || target.equals(originOf(webView.getUrl())))) return false;
                openExternal(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView webView, String url, Bitmap bitmap) {
                epoch++;
                currentOrigin = originOf(url);
                String origin = currentOrigin;
                if (localOrigin != null && localOrigin.equals(origin)) revokeRemote();
                else if (!boundaryReady || !Objects.equals(trustedOrigin, origin)) {
                    webView.stopLoading();
                    revokeRemote();
                }
                super.onPageStarted(webView, url, bitmap);
            }
            @Override public void onPageFinished(WebView webView, String url) {
                enteringRemote = false;
                currentOrigin = originOf(url);
                if (Objects.equals(localOrigin, originOf(url))) {
                    webView.clearHistory();
                    if (!boundaryReady) webView.evaluateJavascript("document.getElementById('status-line').textContent='当前系统 WebView 缺少安全桥支持，请更新系统 WebView 后重新打开应用。';document.getElementById('btn-enter').disabled=true;", null);
                }
                super.onPageFinished(webView, url);
            }
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                // The renderer is gone: touching the WebView here can SIGSEGV the UI
                // process (observed on emulator). Drop state only, then finish cleanly.
                revokeRemote();
                boundaryReady = false;
                // No JS drain is possible. Require full app restart, never reload the remote realm.
                new android.app.AlertDialog.Builder(getContext())
                    .setTitle("请重新打开行迹")
                    .setMessage("页面进程已退出。请从系统彻底关闭应用后重新打开，再从连接页恢复。")
                    .setPositiveButton("知道了", (dialog, which) -> ((android.app.Activity) getContext()).finish()).show();
                return true;
            }
        });
        view.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override public boolean onCreateWindow(WebView owner, boolean dialog, boolean gesture, android.os.Message message) {
                // A bridge-free disposable view obtains only the requested external URL.
                WebView external = new WebView(getContext());
                external.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                        if (request.isForMainFrame()) openExternal(request.getUrl());
                        external.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) message.obj).setWebView(external);
                message.sendToTarget();
                return true;
            }
        });
        // Listener bound once in load(): re-adding in WebView callbacks segfaults.
    }

    private void openExternal(Uri url) {
        if (!"http".equals(url.getScheme()) && !"https".equals(url.getScheme())) return;
        try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) { }
    }

    /**
     * Bridge bootstrap for the granted remote origin, injected at document start into
     * exactly that origin (addDocumentStartJavaScript's rule set is this single origin —
     * no wildcard). The top-frame guard keeps child frames from ever receiving the
     * bridge, so iframe content cannot reach plugin methods.
     */
    private String remoteBridgeScript() throws Exception {
        List<PluginHandle> handles = new ArrayList<>();
        for (String id : new String[]{"XingjiHost", "CapacitorSQLite", "Filesystem", "SecureStoragePlugin", "Preferences", "App", "Share", "Console", "WebView", "CapacitorHttp", "CapacitorCookies", "SystemBars"}) {
            PluginHandle handle = getBridge().getPlugin(id);
            if (handle != null) handles.add(handle);
        }
        return "if(window===window.top){" + JSExport.getGlobalJS(getContext(), false, false)
            + "window.WEBVIEW_SERVER_URL=" + JSONObject.quote(getBridge().getLocalUrl()) + ";"
            + JSExport.getBridgeJS(getContext()) + JSExport.getPluginJS(handles) + "}";
    }

    private void revokeRemote() {
        // Preserve the current local caller's error reply when granting a remote fails.
        // Remote realms are invalidated immediately, before any local navigation.
        if (!Objects.equals(localOrigin, originOf(getBridge().getWebView().getUrl()))) epoch++;
        trustedOrigin = null;
        enteringRemote = false;
        if (remoteScript != null) { remoteScript.remove(); remoteScript = null; }
    }

    @PluginMethod public void setTrustedOrigin(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            // Granting trust is a local-page privilege, verified against the main-thread
            // origin snapshot: a remote page calling this is at the remote origin.
            if (!boundaryReady || !Objects.equals(currentOrigin, localOrigin)) { call.reject("LOCAL_ONLY"); return; }
            String origin = normalizeOrigin(call.getString("origin"));
            if (origin == null || origin.equals(localOrigin)) { call.reject("ORIGIN_INVALID"); return; }
            // A grant without an SDK message channel would strand the user on a bridgeless
            // remote page (no plugin calls, no navigateToLocal). Only origins the static
            // exact allowNavigation rules cover can be granted: fail closed at grant time.
            if (!getBridge().getAllowedOriginRules().contains(origin)) { call.reject("ORIGIN_NOT_NAVIGABLE"); return; }
            try {
                if (remoteScript != null) remoteScript.remove();
                remoteScript = WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), remoteBridgeScript(), Collections.singleton(origin));
                trustedOrigin = origin;
                enteringRemote = true;
                call.resolve(new JSObject().put("trustedOrigin", origin));
            } catch (Exception e) { revokeRemote(); call.reject("SAFE_BRIDGE_UNAVAILABLE"); }
        });
    }

    @PluginMethod public void getTrustedOrigin(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        JSObject result = new JSObject(); result.put("trustedOrigin", trustedOrigin); call.resolve(result);
    }

    @PluginMethod
    public void setMarker(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty() || value == null) {
            call.reject("MARKER_INVALID");
            return;
        }
        prefs().edit().putString(KEY_MARKER_PREFIX + key, value).apply();
        call.resolve();
    }

    @PluginMethod
    public void getMarker(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("MARKER_INVALID");
            return;
        }
        JSObject result = new JSObject();
        String value = prefs().getString(KEY_MARKER_PREFIX + key, null);
        result.put("value", value);
        call.resolve(result);
    }

    /** SHA-256：输入 base64 字节串，输出小写 hex。非安全上下文的唯一摘要路径。 */
    @PluginMethod
    public void sha256Hex(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        String dataB64 = call.getString("dataBase64");
        if (dataB64 == null) {
            call.reject("DIGEST_INPUT_INVALID");
            return;
        }
        try {
            byte[] bytes = Base64.decode(dataB64, Base64.NO_WRAP);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(bytes);
            StringBuilder hex = new StringBuilder(hashed.length * 2);
            for (byte b : hashed) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            JSObject result = new JSObject();
            result.put("hex", hex.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("DIGEST_FAILED");
        }
    }

    /** 安全随机：SecureRandom，输出 hex。不降级 Math.random。 */
    @PluginMethod
    public void randomHex(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        Integer length = call.getInt("byteLength");
        if (length == null || length < 1 || length > 1024) {
            call.reject("RANDOM_LENGTH_INVALID");
            return;
        }
        try {
            byte[] bytes = new byte[length];
            new SecureRandom().nextBytes(bytes);
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            JSObject result = new JSObject();
            result.put("hex", hex.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("RANDOM_FAILED");
        }
    }

    /** 当前 WebView 引用（只读探针；不替换其 WebViewClient）。 */
    @PluginMethod
    public void probeWebView(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        JSObject result = new JSObject();
        result.put("available", webView != null);
        result.put("url", currentOrigin);
        call.resolve(result);
    }

    /** Directory.Data only. Final publication claims the name with O_CREAT|O_EXCL (atomic
     * exists→reject; hard links are denied by SELinux for untrusted apps on modern Android).
     * A failed publication never removes a final/original file; a partially written claim
     * created in this call is unlinked by this call. The caller owns orphan recovery.
     */
    private File controlledFile(String relative, boolean mustExist) throws Exception {
        if (relative == null || !relative.startsWith("xingji-mobile-v1/")) throw new IOException("PATH_INVALID");
        String[] parts = relative.split("/", -1);
        File cursor = getContext().getFilesDir();
        for (int i = 0; i < parts.length; i++) {
            if (parts[i].equals(".") || parts[i].equals("..") || !parts[i].matches("[A-Za-z0-9._-]+")) throw new IOException("PATH_INVALID");
            cursor = new File(cursor, parts[i]);
            try {
                StructStat stat = Os.lstat(cursor.getPath());
                if (OsConstants.S_ISLNK(stat.st_mode) || (i < parts.length - 1 && !OsConstants.S_ISDIR(stat.st_mode))) throw new IOException("PATH_INVALID");
            } catch (ErrnoException e) {
                if (e.errno != OsConstants.ENOENT || i < parts.length - 1 || mustExist) throw e;
            }
        }
        return cursor;
    }

    private static String hex(byte[] bytes) {
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    @PluginMethod public void promoteFileExclusive(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        String from = call.getString("temporaryPath"), to = call.getString("finalPath"), expected = call.getString("expectedSha256");
        Long expectedSize = call.getLong("expectedSize");
        if (expectedSize == null) { Integer integer = call.getInt("expectedSize"); if (integer != null) expectedSize = integer.longValue(); }
        if (expectedSize == null || expectedSize < 0 || expected == null || !expected.matches("[0-9a-f]{64}") || Objects.equals(from, to)) {
            call.reject("FILE_INPUT_INVALID"); return;
        }
        try {
            File temporary = controlledFile(from, true), destination = controlledFile(to, false);
            java.io.FileDescriptor fd = Os.open(temporary.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
            long size = 0;
            if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode)) { Os.close(fd); throw new IOException("PATH_INVALID"); }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] chunk = new byte[65536]; int count;
            while ((count = Os.read(fd, chunk, 0, chunk.length)) > 0) {
                size += count;
                if (size > expectedSize) { Os.close(fd); throw new IOException("FILE_SIZE_MISMATCH"); }
                digest.update(chunk, 0, count);
            }
            if (size != expectedSize || !hex(digest.digest()).equals(expected)) { Os.close(fd); throw new IOException("FILE_DIGEST_MISMATCH"); }
            Os.fsync(fd);
            StructStat verified = Os.fstat(fd), named = Os.lstat(temporary.getPath());
            if (verified.st_ino != named.st_ino || verified.st_dev != named.st_dev || verified.st_size != named.st_size) { Os.close(fd); throw new IOException("FILE_CHANGED"); }
            // O_CREAT|O_EXCL|O_NOFOLLOW: EEXIST is definitive (including a pre-existing
            // symlink); nothing existing is ever truncated or overwritten.
            java.io.FileDescriptor out = Os.open(destination.getPath(),
                OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_WRONLY | OsConstants.O_NOFOLLOW,
                OsConstants.S_IRUSR | OsConstants.S_IWUSR);
            try {
                MessageDigest copyDigest = MessageDigest.getInstance("SHA-256");
                long written = 0;
                Os.lseek(fd, 0, OsConstants.SEEK_SET);
                while ((count = Os.read(fd, chunk, 0, chunk.length)) > 0) {
                    Os.write(out, chunk, 0, count);
                    copyDigest.update(chunk, 0, count);
                    written += count;
                    if (written > size) throw new IOException("FILE_CHANGED");
                }
                if (written != size || !hex(copyDigest.digest()).equals(expected)) throw new IOException("FILE_CHANGED");
                Os.fsync(out);
            } catch (Exception copyError) {
                // Our own claim from this call: a partial file blocks nothing that existed before.
                try { Os.remove(destination.getPath()); } catch (Exception ignored) { }
                throw copyError;
            } finally {
                Os.close(out);
                Os.close(fd);
            }
            java.io.FileDescriptor directory = Os.open(destination.getParent(), OsConstants.O_RDONLY, 0);
            try { if (!OsConstants.S_ISDIR(Os.fstat(directory).st_mode)) throw new IOException("PATH_INVALID"); Os.fsync(directory); } finally { Os.close(directory); }
            // Publication is durable. A leftover staging file is recoverable and never a reason to delete the original.
            temporary.delete();
            JSObject result = new JSObject(); result.put("path", to); result.put("size", size); result.put("sha256", expected); call.resolve(result);
        } catch (ErrnoException e) {
            call.reject(e.errno == OsConstants.EEXIST ? "FILE_EXISTS" : "FILE_PUBLICATION_FAILED");
        } catch (Exception e) {
            String message = e.getMessage();
            call.reject(message != null && message.startsWith("FILE_") || "PATH_INVALID".equals(message) ? message : "FILE_PUBLICATION_FAILED");
        }
    }

    @PluginMethod public void navigateToLocal(PluginCall call) {
        if (!authorized(call)) { call.reject("ORIGIN_DENIED"); return; }
        // The JS caller has drained credentials. Close input, then drain SDK queue too.
        call.resolve();
        getBridge().executeOnMainThread(() -> {
            WebView view = getBridge().getWebView();
            revokeRemote();
            getBridge().execute(() -> getBridge().executeOnMainThread(() -> view.loadUrl(getBridge().getLocalUrl())));
            // History is cleared on local page finish, after the new entry commits.
        });
    }
}
