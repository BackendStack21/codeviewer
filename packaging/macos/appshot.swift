// Build tool: screenshots the running app for the landing page (scripts/shots.ts drives it).
//
//   appshot <url> <steps.json> <out.png> <width> <height> <dark|light>
//
// Loads <url> in an offscreen WKWebView, runs each step of <steps.json> (an array of
// { "js": "<async function body>", "wait": <ms> }) in order, and snapshots the window. If the
// last step returns { x, y, w, h } (CSS pixels), only that rectangle is captured. The PNG comes
// out at the display's scale (2x on Retina).
//
// An offscreen view never fires requestAnimationFrame and never advances CSS animations, so a
// script injected at document start replaces rAF with a timer and turns animations off;
// otherwise the virtualized views stay blank and overlays stay transparent.
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count == 7 else {
  print("usage: appshot <url> <steps.json> <out.png> <width> <height> <dark|light>"); exit(2)
}
let url = URL(string: args[1])!
let steps = (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2])))) as! [[String: Any]]
let output = URL(fileURLWithPath: args[3])
let width = Double(args[4])!
let height = Double(args[5])!
let dark = args[6] == "dark"

let prelude = """
window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
const s = document.createElement('style');
s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .ln.flash, .dr.flash { background: var(--flash) !important; }';
document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
"""

final class Driver: NSObject, WKNavigationDelegate {
  var started = false

  func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
    guard !started else { return }
    started = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.run(web, 0, nil) }
  }

  func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    print("load failed: \(error.localizedDescription)"); exit(1)
  }

  func run(_ web: WKWebView, _ i: Int, _ last: Any?) {
    if i == steps.count { return snap(web, last) }
    let step = steps[i]
    let js = step["js"] as? String ?? ""
    let wait = (step["wait"] as? Double ?? 150) / 1000
    web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
      var value: Any? = nil
      switch result {
      case .success(let v): value = v
      case .failure(let e): print("step \(i) failed: \(e)"); exit(1)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.run(web, i + 1, value) }
    }
  }

  func snap(_ web: WKWebView, _ last: Any?) {
    let config = WKSnapshotConfiguration()
    var rect = CGRect(x: 0, y: 0, width: width, height: height)
    if let r = last as? [String: Any], let x = r["x"] as? Double, let y = r["y"] as? Double,
       let w = r["w"] as? Double, let h = r["h"] as? Double {
      rect = CGRect(x: x, y: y, width: w, height: h).intersection(rect)
    }
    config.rect = rect
    web.takeSnapshot(with: config) { image, error in
      guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:]) else {
        print("snapshot failed: \(error?.localizedDescription ?? "no image")"); exit(1)
      }
      try! png.write(to: output)
      exit(0)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent() // nothing lands in ~/Library/WebKit
config.userContentController.addUserScript(WKUserScript(source: prelude, injectionTime: .atDocumentStart, forMainFrameOnly: true))
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
web.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
let driver = Driver()
web.navigationDelegate = driver
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { print("timed out"); exit(1) }
app.run()
