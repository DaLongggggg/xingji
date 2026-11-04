import Foundation
import CryptoKit
import Security
import Capacitor
import WebKit
import UIKit
import Darwin

/** Main-frame, exact-origin boundary. Persisted addresses never grant native authority.
 * The SDK's public WKNavigationDelegate and WKScriptMessageHandler are retained and
 * forwarded after validation; existing plugin dispatch/queues remain in Capacitor.
 */
@objc(XingjiHostPlugin)
public class XingjiHostPlugin: CAPPlugin, CAPBridgedPlugin, WKScriptMessageHandler {
    public let identifier = "XingjiHostPlugin"
    public let jsName = "XingjiHost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTrustedOrigin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTrustedOrigin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMarker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMarker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sha256Hex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "randomHex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigateToLocal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "promoteFileExclusive", returnType: CAPPluginReturnPromise)
    ]

    private var trustedOrigin: String?
    private var boundaryReady = false
    private var enteringRemote = false
    private var returningLocal = false
    private weak var originalMessages: WKScriptMessageHandler?
    private var navigationBoundary: HostNavigationDelegate?
    private var localOrigin: String? { bridge.map { origin($0.config.localURL) } ?? nil }

    public override func load() {
        guard let bridge = bridge, let webView = bridge.webView else { return }
        let controller = webView.configuration.userContentController
        guard let messages = webView.navigationDelegate as? WKScriptMessageHandler else {
            // Missing public forwarding seam must close the channel, never retain the SDK's unrestricted handler.
            controller.removeScriptMessageHandler(forName: "bridge")
            return
        }
        originalMessages = messages
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(self, name: "bridge")
        let navigation = HostNavigationDelegate(owner: self, original: webView.navigationDelegate)
        navigationBoundary = navigation
        webView.navigationDelegate = navigation
        prefs.removeObject(forKey: "trusted_origin")
        boundaryReady = true
    }

    private func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
              ["http", "https", "capacitor"].contains(scheme), url.user == nil, url.password == nil else { return nil }
        let port = url.port
        let standard = port == nil || (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        return scheme + "://" + host + (standard ? "" : ":\(port!)")
    }

    private func allowed(_ source: String?) -> Bool {
        guard boundaryReady, let source = source else { return false }
        return source == localOrigin || source == trustedOrigin
    }

    private func revokeRemote() {
        trustedOrigin = nil
        enteringRemote = false
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Script injection being main-frame-only is insufficient: frames can post directly.
        let frame = message.frameInfo
        guard frame.isMainFrame, let frameURL = frame.request.url,
              allowed(origin(frameURL)), let currentURL = bridge?.webView?.url,
              origin(frameURL) == origin(currentURL) else { return }
        if let body = message.body as? [String: Any], body["pluginId"] as? String == "XingjiHost",
           body["methodName"] as? String == "setTrustedOrigin", origin(frameURL) != localOrigin {
            // Reject at receipt, before the SDK queue: a later local navigation must not
            // turn a request originally sent by the remote document into local authority.
            if let callback = body["callbackId"] as? String,
               let data = try? JSONSerialization.data(withJSONObject: ["callbackId": callback, "pluginId": "XingjiHost", "methodName": "setTrustedOrigin", "success": false, "error": ["message": "LOCAL_ONLY"]]),
               let json = String(data: data, encoding: .utf8) {
                bridge?.webView?.evaluateJavaScript("window.Capacitor.fromNative(" + json + ")", completionHandler: nil)
            }
            return
        }
        originalMessages?.userContentController(controller, didReceive: message)
    }

    public override func shouldOverrideLoad(_ action: WKNavigationAction) -> NSNumber? {
        guard let url = action.request.url else { return true }
        guard action.targetFrame?.isMainFrame == true else {
            if action.targetFrame == nil { openExternal(url) }
            return true
        }
        let destination = origin(url)
        if destination == localOrigin {
            if returningLocal {
                returningLocal = false
                revokeRemote()
                return false
            }
            // The initial WKWebView frame can have an empty/about:blank URL.
            // An established remote session still requires navigateToLocal.
            if let sourceURL = action.sourceFrame.request.url, let source = origin(sourceURL) {
                if source == localOrigin { revokeRemote(); return false }
                return true
            }
            return NSNumber(value: trustedOrigin != nil)
        }
        if boundaryReady, destination != nil, destination == trustedOrigin,
           enteringRemote || action.sourceFrame.request.url.map({ origin($0) == localOrigin || origin($0) == trustedOrigin }) == true {
            return false
        }
        openExternal(url)
        return true
    }

    private func openExternal(_ url: URL) {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        UIApplication.shared.open(url)
    }

    fileprivate func finished() { enteringRemote = false }

    fileprivate func terminated() {
        revokeRemote()
        boundaryReady = false
        bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        bridge?.showAlertWith(title: "请重新打开行迹", message: "页面进程已退出。请完全退出应用后重新打开，从连接页恢复。", buttonTitle: "知道了")
    }

    private let prefs = UserDefaults.standard
    private let markerPrefix = "marker_"

    private func normalizeOrigin(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty,
              url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil
        else { return nil }
        let port = url.port
        if let port = port, !(1...65535).contains(port) { return nil }
        let isDefaultPort = port == nil
            || (scheme == "http" && port == 80)
            || (scheme == "https" && port == 443)
        return scheme + "://" + host + (isDefaultPort ? "" : ":\(String(port!))")
    }

    @objc func setTrustedOrigin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.boundaryReady, let current = self.bridge?.webView?.url,
                  self.origin(current) == self.localOrigin else { call.reject("LOCAL_ONLY"); return }
            guard let trusted = self.normalizeOrigin(call.getString("origin")), trusted != self.localOrigin else {
                call.reject("ORIGIN_INVALID"); return
            }
            self.trustedOrigin = trusted
            self.enteringRemote = true
            call.resolve(["trustedOrigin": trusted])
        }
    }

    @objc func getTrustedOrigin(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["trustedOrigin": self.trustedOrigin as Any]) }
    }

    @objc func setMarker(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty, let value = call.getString("value") else {
            call.reject("MARKER_INVALID")
            return
        }
        prefs.set(value, forKey: markerPrefix + key)
        call.resolve()
    }

    @objc func getMarker(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("MARKER_INVALID")
            return
        }
        call.resolve(["value": prefs.string(forKey: markerPrefix + key) as Any])
    }

    @objc func sha256Hex(_ call: CAPPluginCall) {
        guard let dataB64 = call.getString("dataBase64"), let bytes = Data(base64Encoded: dataB64) else {
            call.reject("DIGEST_INPUT_INVALID")
            return
        }
        let digest = SHA256.hash(data: bytes)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        call.resolve(["hex": hex])
    }

    @objc func randomHex(_ call: CAPPluginCall) {
        guard let length = call.getInt("byteLength"), length >= 1, length <= 1024 else {
            call.reject("RANDOM_LENGTH_INVALID")
            return
        }
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        guard status == errSecSuccess else {
            call.reject("RANDOM_FAILED")
            return
        }
        call.resolve(["hex": bytes.map { String(format: "%02x", $0) }.joined()])
    }

    private func controlledFile(_ relative: String, mustExist: Bool) throws -> URL {
        guard relative.hasPrefix("xingji-mobile-v1/") else { throw CocoaError(.fileReadInvalidFileName) }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        var url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        for (index, part) in parts.enumerated() {
            guard part != ".", part != "..", part.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else { throw CocoaError(.fileReadInvalidFileName) }
            url.appendPathComponent(String(part))
            var info = stat()
            if lstat(url.path, &info) == 0 {
                guard (info.st_mode & S_IFMT) != S_IFLNK,
                      index == parts.count - 1 || (info.st_mode & S_IFMT) == S_IFDIR else { throw CocoaError(.fileReadInvalidFileName) }
            } else if errno != ENOENT || index != parts.count - 1 || mustExist {
                throw CocoaError(.fileReadInvalidFileName)
            }
        }
        return url
    }

    @objc func promoteFileExclusive(_ call: CAPPluginCall) {
        guard let from = call.getString("temporaryPath"), let to = call.getString("finalPath"), from != to,
              let expectedSize = call.getInt("expectedSize"), expectedSize >= 0,
              let expected = call.getString("expectedSha256"), expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            call.reject("FILE_INPUT_INVALID"); return
        }
        do {
            let temporary = try controlledFile(from, mustExist: true), destination = try controlledFile(to, mustExist: false)
            let fd = open(temporary.path, O_RDONLY | O_NOFOLLOW)
            guard fd >= 0 else { call.reject("FILE_PUBLICATION_FAILED"); return }
            defer { close(fd) }
            var verified = stat()
            guard fstat(fd, &verified) == 0, (verified.st_mode & S_IFMT) == S_IFREG else { call.reject("PATH_INVALID"); return }
            var digest = SHA256(), size = 0
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                let count = buffer.withUnsafeMutableBytes { bytes in Darwin.read(fd, bytes.baseAddress, bytes.count) }
                if count < 0 { call.reject("FILE_PUBLICATION_FAILED"); return }
                if count == 0 { break }
                size += count
                guard size <= expectedSize else { call.reject("FILE_SIZE_MISMATCH"); return }
                digest.update(data: Data(buffer.prefix(count)))
            }
            let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
            guard size == expectedSize, actual == expected else { call.reject("FILE_DIGEST_MISMATCH"); return }
            var named = stat()
            guard fsync(fd) == 0, lstat(temporary.path, &named) == 0, named.st_ino == verified.st_ino,
                  named.st_dev == verified.st_dev, named.st_size == verified.st_size else { call.reject("FILE_CHANGED"); return }
            // link(2) atomically fails on any existing final name; never delete a final file on failure.
            guard link(temporary.path, destination.path) == 0 else { call.reject(errno == EEXIST ? "FILE_EXISTS" : "FILE_PUBLICATION_FAILED"); return }
            let directory = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY)
            guard directory >= 0 else { call.reject("FILE_PUBLICATION_FAILED"); return }
            let synced = fsync(directory)
            close(directory)
            guard synced == 0 else { call.reject("FILE_PUBLICATION_FAILED"); return }
            _ = unlink(temporary.path)
            call.resolve(["path": to, "size": size, "sha256": actual])
        } catch { call.reject("PATH_INVALID") }
    }

    /// The JS caller drains credentials first; revoke authority before loading the local URL.
    @objc func navigateToLocal(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let bridge = self.bridge, let webView = bridge.webView else {
                call.reject("LOCAL_NAVIGATION_UNAVAILABLE"); return
            }
            self.revokeRemote()
            self.returningLocal = true
            webView.load(URLRequest(url: bridge.config.localURL))
            call.resolve()
        }
    }
}

/// Preserve the SDK navigation callbacks, including bridge reset and TLS policy. The one
/// intentionally unforwarded callback is renderer death: the SDK would reload the remote page.
private final class HostNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var owner: XingjiHostPlugin?
    weak var original: WKNavigationDelegate?
    init(owner: XingjiHostPlugin, original: WKNavigationDelegate?) { self.owner = owner; self.original = original }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let original = original { original.webView?(webView, decidePolicyFor: action, decisionHandler: decisionHandler) }
        else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // webView.url can still name the previous document here. Local authority is
        // revoked when that destination is accepted above, never from this stale URL.
        original?.webView?(webView, didStartProvisionalNavigation: navigation)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        owner?.finished()
        original?.webView?(webView, didFinish: navigation)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        original?.webView?(webView, didFail: navigation, withError: error)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        original?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let original = original { original.webView?(webView, didReceive: challenge, completionHandler: completionHandler) }
        else { completionHandler(.performDefaultHandling, nil) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { owner?.terminated() }
}
