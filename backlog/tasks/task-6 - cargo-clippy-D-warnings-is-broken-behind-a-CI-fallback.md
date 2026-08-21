---
id: TASK-6
title: cargo clippy -D warnings is broken behind a CI fallback
status: To Do
assignee: []
created_date: '2026-08-21 22:36'
labels:
  - ci
  - rust
dependencies: []
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
lint.yml runs `cargo clippy --all-targets -- -D warnings || cargo clippy`. The first form currently fails with 4 errors, so every run silently takes the fallback and the job reports green. Verified on origin/main by stashing an unrelated change, so this predates PR #20.

The four: empty line after doc comment (src/secrets.rs:24), function `has_placeholder` is never used (src/secrets.rs:151), items after a test module (src/speaker/macos.rs:318), needless borrow (src/lib.rs:105).

The fallback means the gate has never actually gated, so the count can only grow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The four existing clippy errors are resolved
- [ ] #2 lint.yml fails when clippy reports a warning, with no fallback that hides it
<!-- AC:END -->
