// Codeviewer.app: a native macOS shell around the codeviewer server.
//
// Each window owns one server process (Contents/Resources/codeviewer) for one folder and
// shows it in a WKWebView. WebKit is part of macOS, so the app bundles no browser.
// Hardening mirrors DESIGN.md §8: an ephemeral (non-persistent) data store, a content rule
// list that blocks every request not addressed to the loopback server, and external links
// handed to the user's default browser.
import Cocoa
import WebKit

/// Content rules for one window: block everything except this window's own server
/// (http and ws on 127.0.0.1:<port>). WebKit's rule regexes support no alternation, hence one
/// rule per scheme. In the raw strings, "\\." is a JSON-escaped regex dot.
func contentRules(port: Int) -> String {
    let allow = { (scheme: String) in
        #"{"trigger":{"url-filter":"^"# + scheme + #"://127\\.0\\.0\\.1:"# + String(port) + #"/"},"action":{"type":"ignore-previous-rules"}}"#
    }
    return #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},"# + allow("http") + "," + allow("ws") + "]"
}

// MARK: - Server process

final class Server {
    let folder: URL
    private let process = Process()
    private var buffer = Data()
    private var ready: ((Result<URL, Error>) -> Void)?

    init(folder: URL) { self.folder = folder }

    func start(_ done: @escaping (Result<URL, Error>) -> Void) {
        guard let exe = Bundle.main.url(forResource: "codeviewer", withExtension: nil) else {
            return done(.failure(NSError(domain: "codeviewer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Server binary missing from the app bundle."])))
        }
        ready = done
        process.executableURL = exe
        process.arguments = [folder.path, "--no-open", "--machine", "--exit-with-parent"]
        process.currentDirectoryURL = folder
        // Apps launched from Finder get launchd's minimal environment.
        var env = ProcessInfo.processInfo.environment
        if env["SHELL"] == nil, let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell { env["SHELL"] = String(cString: sh) }
        if env["LANG"] == nil && env["LC_ALL"] == nil { env["LANG"] = "en_US.UTF-8" }
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.standardError
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            DispatchQueue.main.async { self?.consume(chunk) }
        }
        process.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                self?.fail("The codeviewer server exited (code \(p.terminationStatus)).")
            }
        }
        do { try process.run() } catch { fail(error.localizedDescription) }
    }

    /// The server prints one JSON line, {"url": "..."}, when it is listening.
    private func consume(_ chunk: Data) {
        if chunk.isEmpty { return }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0a) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
               let s = obj["url"] as? String, let url = URL(string: s), let cb = ready {
                ready = nil
                cb(.success(url))
            }
        }
    }

    private func fail(_ msg: String) {
        guard let cb = ready else { return }
        ready = nil
        cb(.failure(NSError(domain: "codeviewer", code: 2, userInfo: [NSLocalizedDescriptionKey: msg])))
    }

    func stop() {
        ready = nil
        process.terminationHandler = nil
        if process.isRunning { process.terminate() }
    }
}

// MARK: - Window

/// Remembers the latest mouse-down so the page can turn it into a native window drag.
final class AppWebView: WKWebView {
    var lastMouseDown: NSEvent?
    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }
}

final class ViewerWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let webView: AppWebView
    let server: Server
    var onClose: ((ViewerWindow) -> Void)?

    private var port = -1 // the only origin this window may talk to: http://127.0.0.1:<port>

    init(folder: URL) {
        server = Server(folder: folder)

        // Frameless look: the page draws the title bar; the traffic lights float over it.
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1480, screen.width * 0.86), height: min(940, screen.height * 0.88))
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // An empty compact toolbar gives a taller title bar with vertically centered buttons.
        window.toolbar = NSToolbar(identifier: "codeviewer")
        window.toolbarStyle = .unifiedCompact
        window.layoutIfNeeded()
        let metrics = ViewerWindow.titlebarMetrics(window)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // no cookies, cache or storage survive the window
        config.preferences.isElementFullscreenEnabled = false
        config.userContentController.addUserScript(WKUserScript(
            source: """
            document.documentElement.dataset.native = 'macos';
            document.documentElement.style.setProperty('--native-titlebar-h', '\(metrics.height)px');
            document.documentElement.style.setProperty('--native-inset', '\(metrics.inset)px');
            """,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = AppWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.alphaValue = 0 // revealed after first paint: no white flash
        webView.isInspectable = ProcessInfo.processInfo.environment["CODEVIEWER_INSPECT"] != nil

        super.init()
        config.userContentController.add(self, name: "native")
        window.title = folder.lastPathComponent // hidden, but used by Mission Control and the Window menu
        window.representedURL = folder
        window.backgroundColor = NSColor(srgbRed: 0.047, green: 0.059, blue: 0.082, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 640, height: 420)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .preferred
        window.setFrameAutosaveName("CodeviewerWindow")
        if window.frame.origin == .zero { window.center() }
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    /// Title bar height and the x where the traffic lights end, measured from AppKit's own layout.
    static func titlebarMetrics(_ w: NSWindow) -> (height: Int, inset: Int) {
        let height = w.frame.height - w.contentLayoutRect.height
        let zoom = w.standardWindowButton(.zoomButton)
        let inset = zoom.map { $0.convert($0.bounds, to: nil).maxX } ?? 72
        return (Int(height.rounded()), Int(inset.rounded()))
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        server.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let url): self.loadPinned(url)
            case .failure(let err): self.fail(err.localizedDescription)
            }
        }
    }

    /// Fails closed: the page only loads once the per-port blocking rules are installed.
    private func loadPinned(_ url: URL) {
        guard url.scheme == "http", url.host == "127.0.0.1", let port = url.port else { return fail("Unexpected server address.") }
        self.port = port
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "codeviewer-\(port)", encodedContentRuleList: contentRules(port: port)
        ) { [weak self] list, err in
            guard let self else { return }
            guard let list, err == nil else {
                return self.fail("Couldn't install the network rules (\(err?.localizedDescription ?? "unknown error")).")
            }
            self.webView.configuration.userContentController.add(list)
            self.webView.load(URLRequest(url: url))
        }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Couldn't open \(server.folder.lastPathComponent)"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in self.window.close() }
    }

    private func isOwnServer(_ u: URL) -> Bool {
        u.scheme == "http" && u.host == "127.0.0.1" && u.port == port && port > 0
    }

    // Messages from the page:
    //   {t: "theme", dark, bg}  sync the window appearance
    //   {t: "drag"}            mouse-down on empty title bar: move the window
    //   {t: "dblclick"}        double-click on the title bar: system zoom/minimize action
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let t = body["t"] as? String else { return }
        if t == "drag" {
            if let e = webView.lastMouseDown { window.performDrag(with: e) }
            return
        }
        if t == "relaunch" {
            (NSApp.delegate as? AppDelegate)?.relaunch()
            return
        }
        if t == "dblclick" {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }
        guard t == "theme" else { return }
        let dark = body["dark"] as? Bool ?? true
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        if let hex = body["bg"] as? String, let c = NSColor(hex: hex) {
            window.backgroundColor = c
            webView.underPageBackgroundColor = c
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            webView.animator().alphaValue = 1
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if isOwnServer(url) || url.absoluteString == "about:blank" {
            return decisionHandler(.allow)
        }
        openExternally(url)
        decisionHandler(.cancel)
    }

    // window.open(): never a new web view; external links go to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func openExternally(_ url: URL) {
        if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
    }

    // In full screen the traffic lights are hidden, so the page drops its left inset.
    func windowWillEnterFullScreen(_ notification: Notification) { setFullScreenAttribute(true) }
    func windowDidExitFullScreen(_ notification: Notification) { setFullScreenAttribute(false) }

    private func setFullScreenAttribute(_ on: Bool) {
        webView.evaluateJavaScript("document.documentElement.toggleAttribute('data-fullscreen', \(on))")
    }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        server.stop()
        onClose?(self)
    }
}

extension NSColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [ViewerWindow] = []
    private var openedSomething = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()
        NSWindow.allowsAutomaticWindowTabbing = true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `codeviewer <dir>` from a terminal runs: open -n -a Codeviewer --args --folder <dir>
        // (a restart after an update passes one --folder per window).
        let args = CommandLine.arguments
        for (i, a) in args.enumerated() where a == "--folder" && i + 1 < args.count {
            open(folder: URL(fileURLWithPath: args[i + 1], isDirectory: true))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if !self.openedSomething { self.chooseFolder(nil) }
        }
    }

    // Folders dropped on the Dock icon or opened via Finder's "Open With".
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir) {
                open(folder: isDir.boolValue ? u : u.deletingLastPathComponent())
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { chooseFolder(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        windows.forEach { $0.server.stop() }
    }

    func open(folder: URL) {
        openedSomething = true
        let w = ViewerWindow(folder: folder.standardizedFileURL)
        w.onClose = { [weak self] closed in self?.windows.removeAll { $0 === closed } }
        windows.append(w)
        if let key = NSApp.keyWindow, key.tabbingMode != .disallowed, windows.count > 1 {
            key.addTabbedWindow(w.window, ordered: .above)
        }
        w.show()
        NSDocumentController.shared.noteNewRecentDocumentURL(folder)
    }

    @objc func chooseFolder(_ sender: Any?) {
        openedSomething = true
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Open"
        panel.message = "Choose a folder to view"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK {
            panel.urls.forEach { open(folder: $0) }
        } else if windows.isEmpty {
            NSApp.terminate(nil)
        }
    }

    /// Restarts into the freshly installed bundle (same path), reopening every window's folder.
    func relaunch() {
        var args = ["-n", Bundle.main.bundlePath, "--args"]
        for w in windows { args += ["--folder", w.server.folder.path] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = args
        // Let this process exit first so the new one isn't merged into it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            try? p.run()
            NSApp.terminate(nil)
        }
    }

    /// Runs the update check in the front window's page (which owns the update UI).
    @objc func checkForUpdates(_ sender: Any?) {
        let w = windows.first { $0.window == NSApp.keyWindow } ?? windows.first
        guard let w else { return chooseFolder(nil) }
        w.window.makeKeyAndOrderFront(nil)
        w.webView.evaluateJavaScript("window.dispatchEvent(new Event('cv-check-updates'))")
    }

    /// Symlinks the bundled CLI into /usr/local/bin (asks for an administrator password).
    @objc func installCommandLineTool(_ sender: Any?) {
        guard let exe = Bundle.main.url(forResource: "codeviewer", withExtension: nil)?.path else { return }
        let target = "/usr/local/bin/codeviewer"
        let quoted = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let shell = "mkdir -p /usr/local/bin && ln -sf \(quoted(exe)) \(quoted(target))"
        let source = "do shell script \"\(shell.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\" with administrator privileges"
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        let alert = NSAlert()
        if error == nil {
            alert.messageText = "Command installed"
            alert.informativeText = "Run `codeviewer <folder>` in any terminal to open it here."
        } else {
            alert.messageText = "The command was not installed"
            alert.informativeText = (error?[NSAppleScript.errorMessage] as? String) ?? "Cancelled."
        }
        alert.runModal()
    }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            items.forEach { menu.addItem($0) }
            item.submenu = menu
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        submenu("Codeviewer", [
            item("About Codeviewer", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            item("Check for Updates…", #selector(checkForUpdates(_:))),
            .separator(),
            item("Install ‘codeviewer’ Command…", #selector(installCommandLineTool(_:))),
            .separator(),
            item("Hide Codeviewer", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Codeviewer", #selector(NSApplication.terminate(_:)), "q"),
        ])
        // ⌘W is left to the page (closes an editor tab); ⇧⌘W closes the window.
        submenu("File", [
            item("Open Folder…", #selector(chooseFolder(_:)), "o"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]),
        ])
        // Standard responder actions: WKWebView implements copy/paste/selectAll.
        submenu("Edit", [
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("View", [
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowMenu = [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ]
        submenu("Window", windowMenu)
        NSApp.windowsMenu = main.items.last?.submenu
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
