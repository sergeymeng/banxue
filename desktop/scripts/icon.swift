import AppKit
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.18, green: 0.30, blue: 0.48, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 182, yRadius: 182).fill()
NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 270, y: 225, width: 480, height: 585), xRadius: 32, yRadius: 32).fill()
NSColor(calibratedWhite: 0.83, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 312, y: 225, width: 3, height: 585)).fill()
NSColor(calibratedRed: 0.34, green: 0.44, blue: 0.60, alpha: 1).setStroke()
for y in [650, 540, 430] { let p = NSBezierPath(); p.lineWidth = 18; p.lineCapStyle = .round; p.move(to: NSPoint(x: 370, y: y)); p.line(to: NSPoint(x: y == 430 ? 560 : 650, y: y)); p.stroke() }
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
