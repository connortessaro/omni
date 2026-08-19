# dev-harness

Renders the real HUD in a browser so its layout can be measured and seen.

## Why this exists

The HUD is a `tauri-nspanel` panel with `content_protected(true)`. That means it
is excluded from `CGWindowList`, so it cannot be screenshotted, and it accepts no
synthetic keyboard input. There is no way to inspect it from outside the app.
Verifying a layout change used to mean rebuilding, launching, and asking a human
what they saw.

This harness loads the same React tree at `http://localhost:1420/` with Tauri's
IPC bridge mocked, then measures the DOM directly and captures screenshots.

Two bugs it caught immediately, both invisible to `tsc` and `vite build`:

- The shared `Textarea` ships `min-h-16`. A class string with `h-9` but no
  `min-h-9` left the resting HUD 82px instead of 54px.
- The placeholder wrapped to a second line and was clipped. An `<input>`
  truncates overflowing placeholder text; a `<textarea>` wraps it.

## Running it

```bash
npm run dev        # in one shell
npm run hud:probe  # in another
```

Screenshots land in `dev-harness/out/`. The probe exits non-zero on failure, so
it works as a pre-commit or CI gate.

## WebKit, not Chromium

`probe.mjs` uses Playwright's WebKit build because the app ships inside
WKWebView. This is not incidental: Chromium supports `field-sizing: content` and
WebKit does not. A Chromium probe would have passed on a prompt box that never
grows in the real app.

The harness still is not WKWebView-in-Tauri. It catches CSS, layout, and JS
behavior. It does not catch anything that depends on real Tauri commands, native
window management, or global shortcuts.

## Files

| file | what it does |
|---|---|
| `tauri-mock.js` | Defines `window.__TAURI_INTERNALS__` before app code runs, answers each `invoke` with a plausible value, and records every call. `window.__HARNESS__.lastWindowHeight()` reports the height the app last asked the native window for. |
| `probe.mjs` | Drives WebKit, measures resting and grown geometry, simulates a large paste, asserts, and screenshots at the height the app requested. |

## Adding a check

Add a `record(name, pass, detail)` call in `probe.mjs`. Put the measured numbers
in `detail` even when it passes: the numbers are what make a regression obvious
later.

If a new UI element needs selecting, give it a `data-slot` attribute rather than
matching on a class, since classes change with styling.
