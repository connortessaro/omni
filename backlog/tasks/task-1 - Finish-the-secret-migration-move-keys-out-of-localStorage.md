---
id: TASK-1
title: 'Finish the secret migration: move keys out of localStorage'
status: To Do
assignee: []
created_date: '2026-08-19 17:46'
labels:
  - security
  - secrets
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Partial, not closed: it copies, doesn't move. Model listing and STT still read the key from localStorage, so stripping it now breaks both. That's next.

Provider requests already carry {{OMNI_SECRET:NAME}} and Rust substitutes only for the bound origin (commit 5478653). src/lib/functions/secret-migration.ts deliberately copies rather than moves, because src/lib/functions/models.function.ts and src/lib/functions/stt.function.ts still read the plaintext value out of localStorage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 models.function.ts issues its request through streamProviderRequest with a placeholder instead of the key
- [ ] #2 stt.function.ts issues its request through streamProviderRequest with a placeholder instead of the key
- [ ] #3 Dev space provider UI writes via secret_store on save and renders configured state via secret_exists
- [ ] #4 Startup migration deletes the localStorage copy once the credential store holds the value
- [ ] #5 grep of localStorage writes shows no secret-named variable persisted in plaintext
<!-- AC:END -->
