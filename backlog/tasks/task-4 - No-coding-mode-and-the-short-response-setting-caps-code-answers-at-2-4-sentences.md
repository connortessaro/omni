---
id: TASK-4
title: >-
  No coding mode, and the short response setting caps code answers at 2-4
  sentences
status: Done
assignee: []
created_date: '2026-08-19 19:01'
labels:
  - qa
  - prompt
dependencies: []
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The entire base system prompt is "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses" (src/config/constants.ts:29-30). buildEnhancedSystemPrompt then stacks the response-length prompt onto it; short is "Limit your answer to 2-4 sentences maximum" (src/lib/response-settings.constants.ts:22), which is applied verbatim to a request for a multi-file diff.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A code-oriented system prompt exists and is selectable
- [x] #2 Response-length caps do not apply to answers containing code
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:NOTES:BEGIN -->
AC #2 cannot be met literally: nothing knows whether an answer contains code
before the answer exists, and no `max_tokens` is wired to response length (the
only two token caps in the repo are hardcoded literals in the `claude` and
`groq` curl templates). It is met in two layers instead.

1. Unconditional. All three `RESPONSE_LENGTHS` prompts now bind prose only and
   state that code blocks are emitted in full regardless of the limit. This
   covers every path, including `useSystemAudio` and `Generate.tsx`, which
   never see a slash command.
2. Explicit intent. `fetchAIResponse` takes `codeIntent`, and when it is set no
   length prompt is appended at all. Set by `/code`, `/refactor`, `/commit` and
   `/regex`, or by the built-in Code profile being active. `/fix`, `/explain`,
   `/summarize` and `/translate` are prose commands and are deliberately
   excluded.

AC #1 reuses the shipped profile mechanism rather than adding a second one: the
Code profile is a `SystemPrompt` with a negative id merged into the existing
`/system-prompts` gallery, which had no seeded presets before this.
<!-- SECTION:NOTES:END -->
