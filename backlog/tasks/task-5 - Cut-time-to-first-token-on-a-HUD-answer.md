---
id: TASK-5
title: Cut time-to-first-token on a HUD answer
status: In Progress
assignee: []
created_date: '2026-08-21 22:35'
updated_date: '2026-08-22 03:35'
labels:
  - perf
  - hud
dependencies: []
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A timed assessment spends its budget on latency, not answer quality. The only numbers on record are from evals/scripts/run-eval.ts: a vision turn took 3664ms against a 1440x900 region and 6156ms against a 2560x1600 full screen, both gemini-2.5-flash, both end-to-end for the whole response rather than to first token. Nothing measures the HUD path itself, so it is not yet known how much of that is the image, the request assembly in fetchAIResponse, or the provider.

dev-harness/session.mjs already records time-to-first-text and bytes sent for a scripted multi-turn run against a real model, so the instrument exists and is not wired to anything that gates.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 TTFT is measured separately from total response time, on the real HUD path
- [x] #2 The measurement attributes time to image payload, request assembly, and provider round trip
- [x] #3 A regression in TTFT is catchable without a paid eval run
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Phase 1 done, client-side assembly ruled out by measurement.

`node evals/scripts/latency-breakdown.ts` stubs fetch and times every step before
the request leaves the process. Median of 10 runs:

| case | base64 | total | buildMsgs | replacer | stringify |
|---|---|---|---|---|---|
| no image | 0KB | 0.18ms | 0.01ms | 0.01ms | 0ms |
| region 1440x900 | 897KB | 1.37ms | 0.5ms | 0.08ms | 0.14ms |
| full screen 2560x1600 | 557KB | 0.76ms | 0.24ms | 0.05ms | 0.07ms |

The hypothesis going in was `deepVariableReplacer`: it compiles a fresh RegExp per
string per variable and scans the whole string, and `processUserMessageTemplate`
has already inlined the base64 into the body by the time it runs. All true, all
irrelevant. It is 0.08ms on 897KB. Assembly is under 0.05% of a turn. Nothing on
the JS side is worth optimising.

So the budget is provider round trip and inference, and the lever Omni controls is
vision token count, which scales with PIXELS, not bytes. Across 4 graded runs each,
full screen ran ~4069ms against region ~3313ms while carrying the SMALLER base64
(557KB vs 897KB), because 2560x1600 is 4.1MP against 1.3MP.

## Downscaling: latency win confirmed, accuracy NOT confirmed

Tested whether scaling a full-screen capture down to a 1.3MP budget is free, by
running the same fixture at both sizes through evals/scripts/vision-fidelity.ts.
Three runs each, gemini-2.5-flash, truth is the committed .visible.txt:

| pixels | latency (3 runs) | median | CER (3 runs) |
|---|---|---|---|
| 2560x1600 (4.1MP) | 8319, 7376, 16460 | 8319ms | 35.3%, 35.0%, 37.0% |
| 1440x900 (1.3MP) | 4042, 3845, 2743 | 3845ms | 36.4%, 32.1%, 67.1% |

Latency: downscaled won 3/3, median 2.2x faster. That result is solid.

Accuracy: NOT established. Original CER is tight at 35-37%. Downscaled swings
32-67%, and the bad run returned 946 chars against the usual ~1950, so it gave up
early rather than misread. n=3 is too small to call that noise or regression.

Note the ~35% CER at full screen is not a resolution limit, it is the truncation
limit: both sizes read roughly 65% of the visible text and stop. Resolution was
never the binding constraint, which is why halving it costs little.

## Phase 2: TTFT measured and gated. Omni's share is ~9%.

`npm run ttft:probe` (dev-harness/ttft-probe.mjs) measures the real HUD path in
WebKit against a scripted provider: dev-harness/tauri-mock.js now honours
`window.__HARNESS_STREAM__` and emits canned SSE chunks on a fixed schedule, so
round-trip time is a known constant and no credential or paid call is involved.
Everything is marked in-page with performance.now(). Medians of 5 runs after a
discarded warm-up:

| segment | no attachment | 688KB PNG |
|---|---|---|
| assembly (submit -> request) | 2ms | 14ms |
| provider (scripted round trip) | 301ms | 301ms |
| render (first chunk -> first paint) | 23ms | 24ms |
| **TTFT (submit -> first paint)** | **328ms** | **341ms** |
| Omni's own share | 25ms | 38ms |

The three segments sum to TTFT within 2ms, so nothing is unaccounted for.

Conclusions:
- The app contributes roughly 25-38ms of a ~330ms TTFT. Everything else is the
  provider. This closes the question Phase 1 opened: it is not just assembly that
  is cheap, the whole client path is.
- The image payload costs ~12ms of assembly and ~13ms of TTFT for 899KB. Not a
  TTFT lever.
- The HUD does stream: the first character paints ~683ms before the last chunk
  over a 708ms stream. A regression to render-on-complete would show as ~700ms.

Instrument note worth keeping: the chunk cadence was 2ms at first, a 500/sec
firehose no provider produces, and the render segment swung 193-740ms across
identical runs because first paint was contending with hundreds of queued React
updates. At a realistic 25ms cadence it is a stable 23-25ms. Measuring TTFT
against a synthetic flood measures the flood.

The gate is not vacuous: at the 2ms cadence it failed the render budget and
exited 1. It runs in CI as "HUD Time-to-First-Token".

## Next, in order
1. Before shipping any downscale, get the accuracy question to n>=10 on the GRADED
   tasks rather than transcribe-everything. Transcription CER is high-variance in
   both arms because the failure mode is the model stopping early; the substring
   graders were stable (region 4/4 PASS, full screen 4/4 FAIL). This one costs
   money.
2. Only then consider a pixel budget in capture.rs. Region capture crops and
   preserves text size; a budget scales and shrinks it. TASK-2 already banked the
   crop, so the budget only protects the full-screen path and very large regions.
   Note the measurement above: a pixel budget buys provider inference time, not
   client time, so it is worth doing for the right reason.
<!-- SECTION:NOTES:END -->
