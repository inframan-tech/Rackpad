# Rackpad

Your phone becomes a trackpad, keyboard and remote for your Mac. Scan a QR code
once and it's an icon on your home screen that connects by itself, at home and
at the office. No App Store app needed.

**Version 1 includes**

- **A trackpad that feels like a Mac's.** Tap to click, two-finger tap to
  right-click, scrolling that keeps gliding after you let go, pinch to zoom,
  three-finger swipes for Mission Control and switching desktops, and
  tap-then-drag.
- **Couch mode** for one thumb. Tap to click, hold to right-click, hold and
  move to drag, and a ribbed scroll strip on the edge (left or right).
- **Live typing and dictation.** What you type appears on the Mac as you type,
  including autocorrect fixes and dictation rewriting earlier words. Sticky
  ⌘ ⌥ ⌃ ⇧ keys, arrows, esc, tab.
- **Click wheel.** An iPod-style wheel for volume with a tick on every notch.
  The centre plays and pauses, ⏮ ⏭ skip, MENU mutes.
- **Smart layout.** The phone changes with the app in front:
  - tab controls for browsers
  - a giant mute button for Zoom, Teams and Google Meet
  - next slide and a timer for Keynote, PowerPoint and Google Slides
  - playback controls for YouTube, Netflix, Spotify, Music and video players
  - everyday shortcuts for everything else
- **Neon trails and themes.** Fingers leave glowing trails, and every click
  ripples on the phone and on the Mac. Themes: Neon, Retro iPod, Glass, Pure
  Black and Haze 🌿.
- **Cursor beacon.** While the phone drives the pointer, the Mac's cursor
  glows, and pulses after a pause, so you can find it from across the room.

## Quick start

On your Mac (Node 18+ and the Xcode Command Line Tools, `xcode-select --install`):

```sh
git clone https://github.com/inframan-tech/rackpad && cd rackpad
npm install
npm start
```

The first start compiles a small native helper, which takes about 30
seconds, then opens the pairing page with a QR code.

1. **Scan the QR code** with your phone's camera and open the link.
2. **Allow Accessibility access** when macOS asks. Go to System Settings →
   Privacy & Security → Accessibility and switch on the app you started
   Rackpad from (Terminal, iTerm, VS Code…). macOS requires this before any
   app can move the pointer or type. If the firewall asks whether `node` may
   accept incoming connections, choose Allow.
3. On iPhone, tap **Share → Add to Home Screen**. From then on, the icon is
   the whole setup.

The QR code points at your Mac's Bonjour name (`your-mac.local`), which the
phone finds on whichever network they're both on. Some office networks block
`.local` names. The pairing page also lists the plain IP address for those.

```
rackpad [--port 8421] [--host name-or-ip] [--pair] [--no-open] [--dry-run] [--verbose]
rackpad reset-token     # unpair every phone
rackpad build-helper    # recompile the native helper
```

## How it works

```
 phone (web app)                      Mac
┌─────────────────┐  WebSocket   ┌──────────────────┐  JSON lines  ┌────────────────────┐
│ gesture         │ ───────────▶ │ Node server      │ ───────────▶ │ RackpadHelper      │
│ recognizers,    │  raw finger  │ pointer accel,   │  move/click/ │ (Swift): CGEvent   │
│ live-typing     │  deltas,     │ momentum, double │  scroll/key/ │ input, beacon &    │
│ diff, wheel     │  taps, text  │ clicks, smart    │  text/media  │ ripple overlays,   │
│                 │ ◀─────────── │ layouts, pairing │ ◀─────────── │ front-app watcher  │
└─────────────────┘  front app,  └──────────────────┘  front app   └────────────────────┘
                     volume
```

- `web/` is the phone app: plain ES modules, no build step. The gesture
  recognizers (`web/js/gestures.js`), the typing diff (`textdiff.js`) and the
  wheel maths (`wheel.js`) are pure functions with tests.
- `server/` is the Node server. `engine.js` turns gestures into input:
  pointer acceleration, double-click detection, and iOS-style scroll momentum
  run on the Mac so the glide stays smooth whatever the Wi-Fi does.
  `layouts.js` holds the smart-layout profiles, which are just data, so
  adding an app is a few lines.
- `helper/RackpadHelper.swift` is the native half. It posts real mouse,
  scroll, keyboard and media-key events. It maps shortcuts to your keyboard
  layout, so ⌘Z is ⌘Z on AZERTY too, draws the beacon and ripples as
  click-through overlay windows, and reports the front app and window title.

A phone needs the pairing code in the QR link to connect. The pairing page
only opens on the Mac itself.

## Development

```sh
npm run dev     # dry run: nothing is controlled, every command is logged
npm test        # unit tests, plus browser end-to-end tests if Playwright is installed
```

Dry run works on any OS. Open the printed URL in a desktop browser (the mouse
works as a finger) or on your phone. The pairing page at
`http://localhost:8421/pair` can pretend different apps are in front, so you
can try the smart layouts.

## Good to know

- **Pinch to zoom** sends ⌘+ / ⌘−. Real trackpad magnify gestures can't be
  synthesized with public macOS APIs, and ⌘+/⌘− works in browsers, Preview,
  Finder and most editors.
- **Vibration on iPhone.** Safari has no vibration API, so Rackpad uses the
  tick iOS 18 plays when a switch toggles. It's one gentle tick, whatever the
  event. Android gets proper vibration patterns.
- **Meeting mute buttons** send each app's own mute shortcut. Rackpad can't
  read whether you're muted, so the button is a toggle.
- **Security.** The connection is plain HTTP on your local network, protected
  by the pairing code. Someone on the same network who can sniff traffic could
  capture that code. On a network you don't trust, run `rackpad reset-token`
  afterwards. HTTPS is on the roadmap.

## Roadmap

**Version 2:** command palette for any app's menus, air mouse / laser
pointer, back-tap and Action Button through Shortcuts, "Send to Mac" in the
share sheet, a live mini screen to touch, and the phone dock.

**Later:** now playing with album art, dark room mode, scenes, the text
editing pad, clipboard tunnel, draw to launch, boss key, and multiple Macs.
These need a native iPhone app: Apple Watch control, lock-screen widgets,
richer haptics, and walk-away lock.
