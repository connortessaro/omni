---
id: TASK-3
title: Code blocks wrap indistinguishably from real newlines at 600px
status: Done
assignee: []
created_date: '2026-08-19 19:01'
labels:
  - qa
  - ui
dependencies: []
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/tailwind.css:201-214 forces white-space: pre-wrap !important on code blocks, so overflow-x: auto never engages. Usable code width in the HUD is about 500px, roughly 55-60 characters at text-sm Geist Mono. A wrapped continuation row starts at the gutter's left edge with no hanging indent, so a wrapped line reads as a real newline. Tables get real horizontal scroll; code does not.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A wrapped code line is visually distinguishable from a line break
- [x] #2 A probe assertion covers it
<!-- AC:END -->
