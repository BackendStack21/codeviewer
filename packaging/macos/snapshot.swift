// Build tool: renders a local HTML file to a PNG with WebKit (usage: snapshot <in.html> <out.png> <width> <height>).
// Used for the landing page's Open Graph image (the PNG comes out at the display's scale).
import Cocoa
import WebKit

let args = CommandLine.arguments
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let width = Double(args[3]) ?? 1200
let height = Double(args[4]) ?? 630

final class Loader: NSObject, WKNavigationDelegate {
  func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
    // Let web fonts and images settle before drawing.
    web.evaluateJavaScript("document.fonts.ready.then(() => true)") { _, _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: width, height: height)
        config.snapshotWidth = NSNumber(value: width)
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
  }
  func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    print("load failed: \(error.localizedDescription)"); exit(1)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))
let loader = Loader()
web.navigationDelegate = loader
web.loadFileURL(input, allowingReadAccessTo: input.deletingLastPathComponent().deletingLastPathComponent())
app.run()
