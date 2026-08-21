---
id: TASK-5
title: Cut time-to-first-token on a HUD answer
status: To Do
assignee: []
created_date: '2026-08-21 22:35'
updated_date: '2026-08-21 22:40'
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
- [ ] #1 TTFT is measured separately from total response time, on the real HUD path
- [ ] #2 The measurement attributes time to image payload, request assembly, and provider round trip
- [ ] #3 A regression in TTFT is catchable without a paid eval run
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Phase 1 done, client-side assembly ruled out by measurement.

`node evals/scripts/latency-breakdown.ts` stubs fetch and times every step before
the request leaves the process. Median of 10 runs, per case:

| case | base64 | total | buildMsgs | replacer | stringify |
|---|---|---|---|---|---|
| no image | 0KB | 0.18ms | 0.01ms | 0.01ms | 0ms |
| region 1440x900 | 897KB | 1.37ms | 0.5ms | 0.08ms | 0.14ms |
| full screen 2560x1600 | 557KB | 0.76ms | 0.24ms | 0.05ms | 0.07ms |

The hypothesis going in was that `deepVariableReplacer` was the cost: it compiles a
fresh RegExp per string per variable and runs a full scan, and by the time it runs
`processUserMessageTemplate` has already inlined the base64 into the body. That is
all true and it does not matter. It is 0.08ms on 897KB. Assembly is under 0.05% of
a turn. Nothing on the JS side is worth optimising.

So the budget is provider round trip and inference, and the one lever Omni controls
is how many vision tokens it sends. That scales with pixel dimensions, not bytes:
across 4 runs each, full screen ran ~4069ms against region ~3313ms while carrying
the SMALLER base64 (557KB vs 897KB), because 2560x1600 is 4.1MP against 1.3MP.
Defaulting to region capture in TASK-2 therefore already banked part of this.

Still open, and why this stays To Do:
- AC #1 is not met. Both numbers above are total response time from eval:run, not
  TTFT. dev-harness/session.mjs already records time-to-first-text on the real HUD
  path and is not wired to anything that gates.
- Untested next lever: downscale a capture to a pixel budget before send, in
  capture.rs rather than in TS, and measure whether accuracy survives it. The
  region-vs-full-screen pair is the instrument for that.
<!-- SECTION:NOTES:END -->
