---
id: TASK-2
title: 'Region capture, not whole screen, by default'
status: Done
assignee: []
created_date: '2026-08-19 19:01'
labels:
  - qa
  - vision
dependencies: []
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Default screenshot config is { enabled: true, mode: "manual" } (src/contexts/app.context.tsx:124-127), so the shortcut grabs the entire screen. Measured: at 1440x900 the model transcribes visible code at 0-1.7% character error rate; at a native 2560x1600 full-screen capture with ~66 code lines it transcribes about 60% and stops, silently. Region capture (capture_selected_area) does not have this problem but is behind a settings toggle with an inverted name.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Region selection is reachable without opening settings
- [x] #2 A full-screen capture tells the user, once, that a region capture reads better
- [x] #3 evals vision-full-screen-capture-tail passes or is replaced by a region-capture equivalent
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:NOTES:BEGIN -->
Root cause was worse than described. `applyOneTimeScreenshotDefaults` already
tried to move users onto region capture and could not: it called
`setScreenshotConfiguration` without ever writing `STORAGE_KEYS.SCREENSHOT_CONFIG`,
while persisting its own `auto-configs-enabled` sentinel, so the override
survived one session and the sentinel blocked every retry. Deleted, and the
`useState` default flipped to `enabled: false`.

AC #3 took the "replaced by a region-capture equivalent" branch.
`vision-full-screen-capture-tail` is kept as a documented known failure, and
`vision-region-capture-tail` is the counterpart. Measured against
gemini-2.5-flash: region PASS 3664ms, full screen FAIL 6156ms
(`missing: DEFAULT_POOLSIZE`).
<!-- SECTION:NOTES:END -->
