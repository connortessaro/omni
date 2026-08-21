---
id: TASK-7
title: Dashboard pages are horizontally clipped at 390px
status: To Do
assignee: []
created_date: '2026-08-21 22:36'
labels:
  - ui
  - responsive
dependencies: []
priority: medium
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DashboardLayout renders a fixed ~240px sidebar that never collapses, so every dashboard route is cut off at phone width. Confirmed on /system-prompts with dev-harness/page-shot.mjs: at 390x844 the sidebar takes the full viewport and the content column is sliced mid-card. Pre-existing and global, previously recorded only in .claude/HANDOFF.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every dashboard route is fully readable at 390px
- [ ] #2 The sidebar collapses or moves rather than being clipped
- [ ] #3 A page-shot or probe check covers one narrow-width route
<!-- AC:END -->
