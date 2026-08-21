---
id: TASK-5
title: Cut time-to-first-token on a HUD answer
status: To Do
assignee: []
created_date: '2026-08-21 22:35'
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
