// Build tool: rasterizes an SVG to a transparent PNG with AppKit (usage: svg2png <in.svg> <out.png> <size>).
// QuickLook thumbnails fill the background, so the app icon is rendered with NSImage instead.
import Cocoa
let args = CommandLine.arguments
guard let img = NSImage(contentsOfFile: args[1]) else { print("cannot load svg"); exit(1) }
let size = Int(args[3]) ?? 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill()
img.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
