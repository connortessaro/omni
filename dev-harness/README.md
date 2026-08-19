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

## Holding a real conversation

The probe needs no key and no network. Some questions cannot be answered without
both: whether the attached files are still in the request on turn 4, what a turn
costs in bytes, how long you stare at a spinner before any text appears.

```bash
npm run dev:live   # vite with the mock injected, plus the provider proxy

node dev-harness/session.mjs --out my-run \
  --attach path/to/source.py \
  --turn "what does this file do?" \
  --turn "what is the first import?"
```

`provider-proxy.mjs` holds the API key, read from `~/.config/omni/eval.env`, and the
page never sees it. That is the same split the shipped app relies on: the frontend
sends `{{OMNI_SECRET:NAME}}` and Rust substitutes it. Driving the UI in a browser
should not quietly undo the property being verified.

Each turn records bytes sent, time to first text, the requested window height,
whether the attached context was actually in the request body, and how many images
went with it. Output lands in `dev-harness/out/<name>/` as `session.json` and
`transcript.md`.

Checks that need a live model, and what they proved:

```bash
# Attached files survive follow-ups. Before the fix, turn 2 answered
# "the first import is urllib3.util.retry.Retry"; it is `socket`.
node dev-harness/session.mjs --out context-persistence \
  --attach evals/.cache/repos/requests-2674/requests/adapters.py \
  --turn "what does the attached file do?" \
  --turn "what is the first import statement in the attached file?"

# Screenshots survive follow-ups. Before the fix the second turn answered
# questions about an image it no longer had.
node dev-harness/session.mjs --out image-followup \
  --attach dev-harness/out/ide/shot-omni-secrets-bind/full-2x.png \
  --turn "what functions are shown in this screenshot?" \
  --turn "what are the first and last line numbers visible?"
```

## Capturing a browser IDE

`ide-capture.mjs` screenshots a code editor running in a browser and records the
text that was on screen at that moment, so a transcription can be scored against
what was provably visible rather than against a guess.

```bash
node dev-harness/ide-capture.mjs \
  --url "https://github1s.com/psf/requests/blob/0be38a0c/requests/adapters.py" \
  --out vscode-adapters --viewport 2560x1600 --scale 1
```

Pair it with `evals/scripts/vision-fidelity.ts` for a character error rate.
Measured with gemini-2.5-flash: 0.0% at 1440x900 on GitHub's blob view, 1.5% on a
dark VS Code theme, and 39.8% on a 2560x1600 full-screen capture, where the model
transcribes about 60% of the visible code and stops without saying so.

## Files

| file | what it does |
|---|---|
| `tauri-mock.js` | Defines `window.__TAURI_INTERNALS__` before app code runs, answers each `invoke` with a plausible value, and records every call. `window.__HARNESS__.lastWindowHeight()` reports the height the app last asked the native window for; `callsFor("provider_request")` exposes the outbound request bodies. |
| `seed-settings.js` | Fills the settings a fresh browser profile cannot have: selected provider and model, image support. Override per load with `?harnessProvider=&harnessModel=`. |
| `probe.mjs` | Drives WebKit, measures resting and grown geometry, simulates a large paste, asserts, and screenshots at the height the app requested. Needs no key. |
| `provider-proxy.mjs` | Holds the API key and forwards provider requests, streaming the reply back. Records bytes and latency per call at `GET /stats`. |
| `dev-live.mjs` | Runs vite with the mock injected alongside the proxy, and kills both together. |
| `session.mjs` | Runs a scripted multi-turn conversation against a real model and records what each turn cost. |
| `ide-capture.mjs` | Screenshots a browser IDE and records the text that was visible. |

## Adding a check

Add a `record(name, pass, detail)` call in `probe.mjs`. Put the measured numbers
in `detail` even when it passes: the numbers are what make a regression obvious
later.

If a new UI element needs selecting, give it a `data-slot` attribute rather than
matching on a class, since classes change with styling.
