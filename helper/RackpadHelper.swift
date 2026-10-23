// RackpadHelper — the native half of Rackpad.
//
// Reads one JSON command per line on stdin (sent by the Node server), posts
// the matching mouse/keyboard events, draws the cursor beacon and click
// ripples, and reports the frontmost app on stdout as JSON lines.
//
// Build: swiftc -O -swift-version 5 -o rackpad-helper RackpadHelper.swift
// (the Node server does this automatically on first run).

import AppKit
import ApplicationServices
import Carbon
import QuartzCore

// MARK: - Output to Node

let outQueue = DispatchQueue(label: "rackpad.stdout")

func emit(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    outQueue.async { FileHandle.standardOutput.write(data) }
}

func num(_ v: Any?) -> Double {
    guard let n = v as? NSNumber else { return 0 }
    let d = n.doubleValue
    return d.isFinite ? max(-100_000, min(100_000, d)) : 0
}

func int32(_ v: Any?) -> Int32 { Int32(num(v).rounded()) }

func parseColor(hex: String?, fallback: NSColor) -> NSColor {
    guard let hex = hex, hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else { return fallback }
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

// MARK: - Keyboard layout

/// Maps characters to key codes on the user's current keyboard layout, so a
/// shortcut like Cmd+Z presses the key labelled Z even on AZERTY or QWERTZ.
final class KeyboardLayout {
    private var map: [String: (code: CGKeyCode, shift: Bool)] = [:]
    private let lock = NSLock()

    init() {
        rebuild()
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
            object: nil, queue: .main
        ) { [weak self] _ in self?.rebuild() }
    }

    func rebuild() {
        var fresh: [String: (code: CGKeyCode, shift: Bool)] = [:]
        if let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
           let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
            let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
            if let bytes = CFDataGetBytePtr(data) {
                let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
                // Unshifted first so they win when a character appears twice.
                for shift in [false, true] {
                    let modifiers: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
                    for code in 0..<128 {
                        var dead: UInt32 = 0
                        var length = 0
                        var chars = [UniChar](repeating: 0, count: 4)
                        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers,
                                                    UInt32(LMGetKbdType()), OptionBits(1 << kUCKeyTranslateNoDeadKeysBit),
                                                    &dead, chars.count, &length, &chars)
                        guard status == noErr, length > 0 else { continue }
                        let s = String(utf16CodeUnits: chars, count: length)
                        if fresh[s] == nil { fresh[s] = (CGKeyCode(code), shift) }
                    }
                }
            }
        }
        lock.lock(); map = fresh; lock.unlock()
    }

    func lookup(_ s: String) -> (code: CGKeyCode, shift: Bool)? {
        lock.lock(); defer { lock.unlock() }
        return map[s]
    }
}

// MARK: - Input events

final class Input {
    let source = CGEventSource(stateID: .hidSystemState)
    let layout = KeyboardLayout()
    private var pos = CGEvent(source: nil)?.location ?? .zero
    private var lastPost: TimeInterval = 0
    private var leftDown = false, rightDown = false, otherDown = false
    private var displays: [CGRect] = []

    init() {
        refreshDisplays()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshDisplays()
        }
    }

    func refreshDisplays() {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return }
        let capacity = count
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
        guard CGGetActiveDisplayList(capacity, &ids, &count) == .success else { return }
        displays = ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    }

    /// Where the pointer is. Our own last position while we're actively moving
    /// it (the system's reading can lag a few ms behind), otherwise the real one
    /// so we pick up any movement from a physical mouse.
    private func base() -> CGPoint {
        if now() - lastPost > 0.1, let actual = CGEvent(source: nil)?.location { pos = actual }
        return pos
    }

    private func clamp(_ p: CGPoint, from b: CGPoint) -> CGPoint {
        if displays.isEmpty || displays.contains(where: { $0.contains(p) }) { return p }
        let r = displays.first(where: { $0.contains(b) }) ?? displays[0]
        return CGPoint(x: min(max(p.x, r.minX), r.maxX - 1), y: min(max(p.y, r.minY), r.maxY - 1))
    }

    func move(dx: Double, dy: Double) {
        let b = base()
        let p = clamp(CGPoint(x: b.x + dx, y: b.y + dy), from: b)
        let type: CGEventType
        let button: CGMouseButton
        if leftDown { type = .leftMouseDragged; button = .left }
        else if rightDown { type = .rightMouseDragged; button = .right }
        else if otherDown { type = .otherMouseDragged; button = .center }
        else { type = .mouseMoved; button = .left }
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
        e.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
        e.post(tap: .cghidEventTap)
        pos = p
        lastPost = now()
    }

    func button(_ name: String, down: Bool, clicks: Int) {
        let p = base()
        let type: CGEventType
        let button: CGMouseButton
        switch name {
        case "right":
            type = down ? .rightMouseDown : .rightMouseUp; button = .right; rightDown = down
        case "middle":
            type = down ? .otherMouseDown : .otherMouseUp; button = .center; otherDown = down
        default:
            type = down ? .leftMouseDown : .leftMouseUp; button = .left; leftDown = down
        }
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
        if name == "middle" { e.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
        e.post(tap: .cghidEventTap)
        lastPost = now()
    }

    /// Pixel-precise, continuous scrolling like a trackpad (not wheel "lines").
    func scroll(dx: Int32, dy: Int32) {
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        e.post(tap: .cghidEventTap)
    }

    private static let modifierKeys: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
        ("ctrl", 59, .maskControl), ("alt", 58, .maskAlternate), ("shift", 56, .maskShift),
        ("cmd", 55, .maskCommand), ("fn", 63, .maskSecondaryFn),
    ]

    private func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        e.flags = flags
        e.post(tap: .cghidEventTap)
    }

    /// Presses a key with modifiers, holding the modifier keys down around it
    /// the way a person would (some apps watch the modifier keys themselves).
    func key(code fallback: CGKeyCode, char: String?, mods: [String], times: Int) {
        var code = fallback
        var wanted = Set(mods)
        if let c = char, let mapped = layout.lookup(c) {
            code = mapped.code
            if mapped.shift { wanted.insert("shift") }
        }
        let held = Input.modifierKeys.filter { wanted.contains($0.name) }
        var flags = CGEventFlags()
        for m in held { flags.insert(m.flag); postKey(m.code, down: true, flags: flags) }
        var keyFlags = flags
        // Arrows and the navigation block carry these flags on real keyboards;
        // Mission Control's Ctrl+Arrow shortcuts ignore events without them.
        if (115...126).contains(code) || code == 117 { keyFlags.insert(.maskSecondaryFn) }
        if (123...126).contains(code) { keyFlags.insert(.maskNumericPad) }
        for _ in 0..<max(1, min(times, 500)) {
            postKey(code, down: true, flags: keyFlags)
            postKey(code, down: false, flags: keyFlags)
            if times > 1 { usleep(2000) }
        }
        for m in held.reversed() { flags.remove(m.flag); postKey(m.code, down: false, flags: flags) }
    }

    /// Types arbitrary text (emoji, accents, any language) one character at a time.
    func type(_ text: String) {
        for ch in text {
            if ch.isNewline { key(code: 36, char: nil, mods: [], times: 1); continue }
            if ch == "\t" { key(code: 48, char: nil, mods: [], times: 1); continue }
            let s = String(ch)
            let units = Array(s.utf16)
            // Use the real key when the layout has one: apps that read key
            // codes (terminals, games, remote desktops) then see the right key.
            let mapped = layout.lookup(s)
            let code = mapped?.code ?? 0
            let flags: CGEventFlags = mapped?.shift == true ? .maskShift : []
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
                e.flags = flags
                e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e.post(tap: .cghidEventTap)
            }
            usleep(1000)
        }
    }
}

// MARK: - Media keys

/// Media keys behave exactly like the keyboard's own: they show the volume
/// HUD and control whichever app owns Now Playing.
func postMediaKey(_ name: String) {
    let codes: [String: Int] = ["volup": 0, "voldown": 1, "mute": 7, "playpause": 16, "next": 17, "prev": 18]
    guard let key = codes[name] else { return }
    for down in [true, false] {
        let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
        let data1 = (key << 16) | ((down ? 0xA : 0xB) << 8)
        let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                                    windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)
        ev?.cgEvent?.post(tap: .cghidEventTap)
    }
}

func openMissionControl() {
    for path in ["/System/Applications/Mission Control.app", "/Applications/Mission Control.app"]
    where FileManager.default.fileExists(atPath: path) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
        return
    }
}

// MARK: - Overlays

func makeOverlayWindow(size: CGFloat) -> NSWindow {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size, height: size), styleMask: [.borderless],
                     backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = false
    w.ignoresMouseEvents = true
    w.isReleasedWhenClosed = false
    w.level = .screenSaver
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    let view = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
    view.wantsLayer = true
    w.contentView = view
    return w
}

/// A soft glow that follows the pointer while the phone is driving it, so you
/// can find the cursor from across the room. It pulses in after a pause.
final class Beacon {
    var enabled = true
    var color = NSColor(srgbRed: 0, green: 0.9, blue: 1, alpha: 1) { didSet { applyColor() } }
    private let size: CGFloat = 200
    private lazy var window: NSWindow = {
        let w = makeOverlayWindow(size: self.size)
        self.setUpLayers(in: w)
        return w
    }()
    private let glow = CAGradientLayer()
    private let ring = CAShapeLayer()
    private var follow: Timer?
    private var lastActivity: TimeInterval = 0
    private var visible = false

    private func setUpLayers(in w: NSWindow) {
        guard let root = w.contentView?.layer else { return }
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        glow.type = .radial
        glow.frame = bounds
        glow.startPoint = CGPoint(x: 0.5, y: 0.5)
        glow.endPoint = CGPoint(x: 1, y: 1)
        glow.locations = [0, 0.28, 1]
        ring.frame = bounds
        let r: CGFloat = 24
        ring.path = CGPath(ellipseIn: CGRect(x: size / 2 - r, y: size / 2 - r, width: r * 2, height: r * 2), transform: nil)
        ring.fillColor = nil
        ring.lineWidth = 3
        ring.shadowOffset = .zero
        ring.shadowRadius = 8
        ring.shadowOpacity = 1
        root.addSublayer(glow)
        root.addSublayer(ring)
        root.opacity = 0
        applyColor()
    }

    private func applyColor() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glow.colors = [color.withAlphaComponent(0.42).cgColor, color.withAlphaComponent(0.16).cgColor, color.withAlphaComponent(0).cgColor]
        ring.strokeColor = color.withAlphaComponent(0.95).cgColor
        ring.shadowColor = color.cgColor
        CATransaction.commit()
    }

    /// Called whenever the phone moves the pointer.
    func poke() {
        guard enabled else { return }
        let t = now()
        let afterPause = t - lastActivity > 2.5
        lastActivity = t
        if !visible { show(pulse: afterPause) }
    }

    private func show(pulse: Bool) {
        visible = true
        reposition()
        window.orderFrontRegardless()
        guard let root = window.contentView?.layer else { return }
        root.removeAllAnimations()
        root.opacity = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.15
        root.add(fade, forKey: "fade")
        if pulse {
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 3.2
            grow.toValue = 1
            grow.duration = 0.5
            grow.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ring.add(grow, forKey: "pulse")
        }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.frame() }
        RunLoop.main.add(timer, forMode: .common)
        follow = timer
    }

    private func frame() {
        reposition()
        if now() - lastActivity > 1.4 { hide() }
    }

    private func reposition() {
        let m = NSEvent.mouseLocation
        window.setFrameOrigin(NSPoint(x: m.x - size / 2, y: m.y - size / 2))
    }

    func hide() {
        guard visible else { return }
        visible = false
        follow?.invalidate()
        follow = nil
        guard let root = window.contentView?.layer else { return }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self = self, !self.visible else { return }
            self.window.orderOut(nil)
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = 0.35
        root.opacity = 0
        root.add(fade, forKey: "fade")
        CATransaction.commit()
    }
}

/// A ring that ripples out from the pointer on every click from the phone.
final class Ripples {
    var enabled = true
    var color = NSColor(srgbRed: 0, green: 0.9, blue: 1, alpha: 1)
    var color2 = NSColor(srgbRed: 1, green: 0.24, blue: 0.95, alpha: 1)
    private let size: CGFloat = 150
    private var pool: [NSWindow] = []

    func fire(secondary: Bool) {
        guard enabled else { return }
        let w = pool.popLast() ?? makeOverlayWindow(size: size)
        let m = NSEvent.mouseLocation
        w.setFrameOrigin(NSPoint(x: m.x - size / 2, y: m.y - size / 2))
        guard let root = w.contentView?.layer else { return }
        root.sublayers?.forEach { $0.removeFromSuperlayer() }
        let c = secondary ? color2 : color
        let ring = CAShapeLayer()
        ring.frame = root.bounds
        ring.path = CGPath(ellipseIn: root.bounds.insetBy(dx: 10, dy: 10), transform: nil)
        ring.fillColor = c.withAlphaComponent(0.14).cgColor
        ring.strokeColor = c.cgColor
        ring.lineWidth = 3
        ring.shadowColor = c.cgColor
        ring.shadowRadius = 6
        ring.shadowOpacity = 1
        ring.shadowOffset = .zero
        ring.opacity = 0
        root.addSublayer(ring)
        w.orderFrontRegardless()

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            w.orderOut(nil)
            self?.pool.append(w)
        }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.12
        scale.toValue = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.5
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.add(group, forKey: "ripple")
        CATransaction.commit()
    }
}

// MARK: - Frontmost app

/// Tells Node which app is in front (and its window title, which is how the
/// smart layout spots Google Meet or YouTube inside a browser).
final class AppWatcher {
    private var lastBundle: String?
    private var lastTitle: String?
    private var icons: [String: String] = [:]

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.report()
        }
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.report() }
        RunLoop.main.add(timer, forMode: .common)
        report(force: true)
    }

    func report(force: Bool = false) {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        let bundle = app.bundleIdentifier ?? ""
        let title = AXIsProcessTrusted() ? windowTitle(pid: app.processIdentifier) : nil
        if !force && bundle == lastBundle && title == lastTitle { return }
        lastBundle = bundle
        lastTitle = title
        var obj: [String: Any] = ["ev": "app", "bundleId": bundle, "name": app.localizedName ?? bundle]
        if let t = title { obj["title"] = t }
        if let icon = icon(for: app, key: bundle) { obj["icon"] = icon }
        emit(obj)
    }

    private func windowTitle(pid: pid_t) -> String? {
        let axApp = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let w = window, CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    private func icon(for app: NSRunningApplication, key: String) -> String? {
        if let cached = icons[key] { return cached }
        guard let image = app.icon else { return nil }
        let px = 96
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = NSSize(width: px, height: px)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let url = "data:image/png;base64," + png.base64EncodedString()
        icons[key] = url
        return url
    }
}

// MARK: - Command loop

let input = Input()
let beacon = Beacon()
let ripples = Ripples()
let watcher = AppWatcher()
var lastBeaconPoke: TimeInterval = 0

func handle(_ cmd: [String: Any]) {
    guard let op = cmd["op"] as? String else { return }
    switch op {
    case "move":
        input.move(dx: num(cmd["dx"]), dy: num(cmd["dy"]))
        let t = now()
        if t - lastBeaconPoke > 0.05 {
            lastBeaconPoke = t
            DispatchQueue.main.async { beacon.poke() }
        }
    case "button":
        let name = cmd["b"] as? String ?? "left"
        let down = (cmd["down"] as? Bool) ?? true
        input.button(name, down: down, clicks: Int(num(cmd["n"])))
        if down { DispatchQueue.main.async { ripples.fire(secondary: name != "left") } }
    case "scroll":
        input.scroll(dx: int32(cmd["dx"]), dy: int32(cmd["dy"]))
    case "key":
        let code = CGKeyCode(max(0, min(127, num(cmd["code"]))))
        input.key(code: code, char: cmd["char"] as? String, mods: cmd["mods"] as? [String] ?? [], times: Int(max(1, num(cmd["n"]))))
    case "text":
        if let s = cmd["s"] as? String { input.type(s) }
    case "media":
        if let k = cmd["k"] as? String { DispatchQueue.main.async { postMediaKey(k) } }
    case "missionControl":
        DispatchQueue.main.async { openMissionControl() }
    case "config":
        DispatchQueue.main.async {
            if let b = cmd["beacon"] as? Bool { beacon.enabled = b; if !b { beacon.hide() } }
            if let r = cmd["ripples"] as? Bool { ripples.enabled = r }
            if let c = cmd["color"] as? String {
                beacon.color = parseColor(hex: c, fallback: beacon.color)
                ripples.color = parseColor(hex: c, fallback: ripples.color)
            }
            if let c = cmd["color2"] as? String { ripples.color2 = parseColor(hex: c, fallback: ripples.color2) }
        }
    default:
        break
    }
}

signal(SIGPIPE, SIG_DFL)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Ask for Accessibility access (shows the system prompt the first time), then
// keep checking until it's granted so the phone can say what's missing.
let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
emit(["ev": "ready", "trusted": trusted])
if !trusted {
    let timer = Timer(timeInterval: 2, repeats: true) { t in
        if AXIsProcessTrusted() {
            emit(["ev": "trusted", "value": true])
            t.invalidate()
        }
    }
    RunLoop.main.add(timer, forMode: .common)
}

watcher.start()

// Input commands are handled on their own thread, in order, so typing a long
// dictated sentence never stalls the overlays' animation on the main thread.
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        handle(obj)
    }
    // Node went away: so do we.
    exit(0)
}
reader.qualityOfService = .userInteractive
reader.start()

app.run()
