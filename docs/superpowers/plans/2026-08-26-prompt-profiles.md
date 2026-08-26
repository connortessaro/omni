# Prompt Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six more built-in prompt profiles — Live Interview, Behavioral, System Design, Debug, SQL and Frontend — covering live technical interviews and the CodeSignal and HackerRank task types the existing Assessment profile does not already handle.

**Architecture:** Profile behaviour is currently hardcoded by id in two places: `useCompletion.ts` decides `codeIntent` by comparing against `CODE_PROFILE_ID` and `ASSESSMENT_PROFILE_ID`, and `ProfileChip.tsx` picks an accent the same way. That does not survive eight profiles. Task 1 replaces both with a metadata registry (`src/lib/profiles.ts`) that every consumer reads from, so adding a profile afterwards is data, not branching. Tasks 3 and 4 add the only two new answer shapes these six need — `speak` (an answer said out loud, not transcribed) and `diagram` (a design that leads with a mermaid graph). Debug, SQL and Frontend reuse shapes that already exist and are therefore prompt text plus a registry row.

**Tech Stack:** React 19 + TypeScript strict, Tauri 2, `node --test` with esbuild-bundled `src/` modules (`evals/harness/loadSrcModule.ts`), Playwright WebKit probes (`dev-harness/probe.mjs`, `dev-harness/answer-probe.mjs`), Streamdown for markdown, mermaid and katex rendering.

**Spec:** This plan is its own spec. The profile list and the differentiator for each one are in the "Profile Registry" section below.

## Global Constraints

- Strict TypeScript. No `any` in new code.
- No comments unless the reason is non-obvious. House style is to say *why* and name the failure the code prevents — see `src/lib/assessment.ts` and `src-tauri/src/runner.rs`.
- No silent failures. A profile that cannot be found must fall back visibly, never to an empty prompt.
- **Built-in ids are permanent.** The selected profile is persisted as an id string in `localStorage` under `STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID`. Renumbering an existing profile silently repoints a user's saved selection at a different prompt. Ids are assigned once, in this plan, and Task 1 adds a test that pins them.
- Built-in ids are negative so they cannot collide with a SQLite autoincrement rowid (`src/lib/system-prompts.constants.ts`).
- No em dashes in user-facing copy. Use a colon, a full stop, or a comma.
- Test runner: `npm run eval:test`. Typecheck gates: `npx tsc --noEmit` and `npm run eval:typecheck`. Probes: `npm run hud:probe` and `npm run answer:probe`, both needing `OMNI_HARNESS=1 npx vite --port 1420 --strictPort` in another shell.
- Conventional Commits. Commit at the end of every task.
- Every profile whose prompt carries `ANSWER_CONTRACT_INSTRUCTIONS` must set `contract: true` in the registry, and vice versa. Task 1 adds the test that enforces it.

---

## Profile Registry

Ids are permanent. `contract` means the prompt asks for the fenced `omni` block, so `AnswerCard` renders it verdict-first. `codeIntent` means a prose length cap must be skipped for this profile, because the answer carries code that must not be truncated (`src/lib/functions/ai-response.function.ts:63-72`).

| id | Name | Group | Shape it declares | contract | codeIntent | What it forces that no other profile does |
|---|---|---|---|---|---|---|
| -1 | Code | Type it | none | false | true | Complete runnable code, prose second. Ships today. |
| -2 | Assessment | Type it | choice/code/files/prose | true | true | Verdict first, with a test block. Ships today. |
| -3 | Live Interview | Say it | speak | true | false | An answer to **say**, not read: no markdown, first person, roughly fifteen seconds out loud. |
| -4 | Debug | Type it | code | true | true | Root cause in one line, then the **smallest** diff. Rewriting is forbidden. |
| -5 | System Design | Say it | diagram | true | false | Requirements, numbers, components, tradeoffs, bottleneck, with a mermaid graph first. |
| -6 | Behavioral | Say it | speak | true | false | Situation, Task, Action, Result, in the user's own register, with no invented metrics. |
| -7 | SQL | Type it | code | true | true | One dialect, locked. Query first, plan and indexes second, never an ORM. |
| -8 | Frontend | Type it | files | true | true | Matches the starter code's stack, with selectors a headless grader can drive. |

### Coverage, and what is deliberately absent

The existing **Assessment** profile already covers most of the CodeSignal task list through its four shapes: Quiz, Matrix and Output-Only map to `choice`; Single-Function, Progressive Single-Function, Recovery and Free-Coding to `code`; Filesystem, Progressive Filesystem and Free-Filesystem to `files`; Writing, Conversation and Whiteboard to `prose`. The three `Type it` profiles in this plan are the places where a general "answer the question" prompt measurably produces the wrong thing:

- **Bugfix and Recovery** want the smallest diff. The Code and Assessment profiles both instruct the model to show the whole changed function, which hides the fix inside a rewrite. → Debug.
- **SQL** is graded by running the query against a specific engine, and MySQL and PostgreSQL disagree about enough syntax that a dialect-agnostic answer is a coin flip. → SQL.
- **Simple Frontend, Free-Frontend** and HackerRank's React tasks are driven by a headless browser, so the markup needs stable hooks and the stack has to match whatever starter code is in the editor. → Frontend.

Not in scope, by request: Take-home, Concept Quiz, Math and Writing. No id is reserved for them, so they can be added later at `-9` onward without moving anything that shipped.

---

## File Structure

**New**
- `src/lib/profiles.ts` — the registry. Holds every built-in profile's prompt text and its metadata, plus `profileById`, `profileHasCodeIntent`, `profileAccent` and the group ordering. One file rather than one per profile: the profiles are most often read against each other, and holding all eight in view is what keeps their prompts from drifting apart in voice and strictness.
- `evals/unit/profiles.test.ts` — registry invariants: id stability, contract/`contract` agreement, and the promise each profile makes.

**Modified**
- `src/lib/system-prompts.constants.ts` — stops holding profile data. Derives `BUILTIN_SYSTEM_PROMPTS` from the registry so `useSystemPrompts` and the database path are untouched.
- `src/lib/assessment.ts` — `AnswerShape` gains `speak` and `diagram`; two shape-override strings are added for the profiles that use them.
- `src/lib/index.ts` — exports the new module.
- `src/hooks/useCompletion.ts` — the two hardcoded id comparisons become one `profileHasCodeIntent` call.
- `src/pages/app/components/completion/ProfileChip.tsx` — accent comes from the registry; the menu grows groups, one-line summaries and a scroll region.
- `src/components/AnswerCard/index.tsx` — `SHAPE_STYLES` gains the two new shapes, and the headline and disclosure rules learn about `speak`.
- `dev-harness/probe.mjs` — the profile menu check has to survive eight entries and grouping.
- `dev-harness/answer-probe.mjs` — cases for the `speak` and `diagram` shapes.
- `README.md` — the profile list.

---

### Task 1: Profile registry replaces the hardcoded ids

**Files:**
- Create: `src/lib/profiles.ts`
- Create: `evals/unit/profiles.test.ts`
- Modify: `src/lib/system-prompts.constants.ts` (whole file)
- Modify: `src/lib/index.ts` (add one export line)
- Modify: `src/hooks/useCompletion.ts` (the `codeIntent` block and its imports)
- Modify: `src/pages/app/components/completion/ProfileChip.tsx` (the `accentFor` helper and its imports)

**Interfaces:**
- Consumes: `ANSWER_CONTRACT_INSTRUCTIONS` and `ASSESSMENT_SYSTEM_PROMPT` from `src/lib/assessment.ts`; `CODING_SYSTEM_PROMPT` from `src/config/constants.ts`.
- Produces:
  - `type ProfileGroup = "Type it" | "Say it"`
  - `type ProfileAccent = "cyan" | "violet" | "rose" | "indigo" | "amber" | "slate"`
  - `interface BuiltinProfile { id: number; name: string; summary: string; prompt: string; group: ProfileGroup; accent: ProfileAccent; codeIntent: boolean; contract: boolean }`
  - `const BUILTIN_PROFILES: BuiltinProfile[]`
  - `const PROFILE_GROUP_ORDER: ProfileGroup[]`
  - `const CODE_PROFILE_ID: number`, `const ASSESSMENT_PROFILE_ID: number`
  - `profileById(id: number | null): BuiltinProfile | undefined`
  - `profileHasCodeIntent(id: number | null): boolean`
  - `profileAccent(id: number | null): ProfileAccent`

- [ ] **Step 1: Write the failing test**

Create `evals/unit/profiles.test.ts`:

```ts
// The registry is the single place a profile's behaviour is declared. These cover the
// invariants that break silently: an id that moves repoints every saved selection at a
// different prompt, and a profile whose metadata disagrees with its own prompt text gets
// a length cap applied to code or a verdict panel with nothing to render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

interface ProfilesModule {
  BUILTIN_PROFILES: Array<{
    id: number;
    name: string;
    summary: string;
    prompt: string;
    group: string;
    accent: string;
    codeIntent: boolean;
    contract: boolean;
  }>;
  PROFILE_GROUP_ORDER: string[];
  CODE_PROFILE_ID: number;
  ASSESSMENT_PROFILE_ID: number;
  profileById(id: number | null): { name: string } | undefined;
  profileHasCodeIntent(id: number | null): boolean;
  profileAccent(id: number | null): string;
}

const load = () => loadSrcModule<ProfilesModule>("lib/profiles.ts");

// Pinned on purpose. The selected profile is persisted as an id, so moving one silently
// hands a user a different prompt than the one they chose.
const PINNED_IDS: Record<string, number> = {
  Code: -1,
  Assessment: -2,
};

test("built-in ids never move", async () => {
  const { BUILTIN_PROFILES } = await load();
  for (const [name, id] of Object.entries(PINNED_IDS)) {
    const profile = BUILTIN_PROFILES.find((p) => p.name === name);
    assert.ok(profile, `a built-in named ${name} must ship`);
    assert.equal(profile.id, id, `${name} must keep id ${id}`);
  }
});

test("every built-in id is negative and unique", async () => {
  const { BUILTIN_PROFILES } = await load();
  const ids = BUILTIN_PROFILES.map((p) => p.id);
  assert.ok(ids.every((id) => id < 0), "built-in ids must be negative");
  assert.equal(new Set(ids).size, ids.length, "built-in ids must be unique");
});

test("every profile carries a name and a one-line summary", async () => {
  const { BUILTIN_PROFILES } = await load();
  for (const profile of BUILTIN_PROFILES) {
    assert.ok(profile.name.length > 0, `${profile.id} needs a name`);
    assert.ok(profile.summary.length > 0, `${profile.name} needs a summary`);
    assert.ok(
      profile.summary.length <= 60,
      `${profile.name} summary must fit the picker: ${profile.summary}`
    );
    assert.ok(profile.prompt.trim().length > 0, `${profile.name} needs a prompt`);
  }
});

test("a profile's contract flag agrees with its own prompt", async () => {
  const { BUILTIN_PROFILES } = await load();
  const { ANSWER_CONTRACT_INSTRUCTIONS } = await loadSrcModule<{
    ANSWER_CONTRACT_INSTRUCTIONS: string;
  }>("lib/assessment.ts");

  for (const profile of BUILTIN_PROFILES) {
    const carries = profile.prompt.includes(ANSWER_CONTRACT_INSTRUCTIONS);
    assert.equal(
      carries,
      profile.contract,
      `${profile.name}: contract=${profile.contract} but prompt ${
        carries ? "carries" : "omits"
      } the contract`
    );
  }
});

test("a profile that answers with code never asks for concision", async () => {
  const { BUILTIN_PROFILES } = await load();
  // The generic prompt's own instruction to be concise is what made a multi-file diff
  // come back as a summary. A profile that skips the length cap must not reintroduce it.
  for (const profile of BUILTIN_PROFILES.filter((p) => p.codeIntent)) {
    assert.ok(
      !/\bconcise\b/i.test(profile.prompt),
      `${profile.name} must not ask for concision`
    );
  }
});

test("every group in the registry is in the picker's ordering", async () => {
  const { BUILTIN_PROFILES, PROFILE_GROUP_ORDER } = await load();
  for (const profile of BUILTIN_PROFILES) {
    assert.ok(
      PROFILE_GROUP_ORDER.includes(profile.group),
      `${profile.name} is in group ${profile.group}, which the picker does not order`
    );
  }
});

test("lookups answer for a known id and stay quiet for an unknown one", async () => {
  const { profileById, profileHasCodeIntent, profileAccent, CODE_PROFILE_ID } =
    await load();

  assert.equal(profileById(CODE_PROFILE_ID)?.name, "Code");
  assert.equal(profileHasCodeIntent(CODE_PROFILE_ID), true);
  assert.equal(profileAccent(CODE_PROFILE_ID), "cyan");

  // A profile the user typed is a positive rowid and has no registry entry. It must read
  // as neutral rather than throwing or inheriting another profile's behaviour.
  assert.equal(profileById(7), undefined);
  assert.equal(profileHasCodeIntent(7), false);
  assert.equal(profileAccent(7), "slate");
  assert.equal(profileHasCodeIntent(null), false);
  assert.equal(profileAccent(null), "slate");
});

test("the derived built-in list still matches the registry", async () => {
  const { BUILTIN_PROFILES } = await load();
  const { BUILTIN_SYSTEM_PROMPTS } = await loadSrcModule<{
    BUILTIN_SYSTEM_PROMPTS: Array<{ id: number; name: string; prompt: string }>;
  }>("lib/system-prompts.constants.ts");

  assert.equal(BUILTIN_SYSTEM_PROMPTS.length, BUILTIN_PROFILES.length);
  for (const profile of BUILTIN_PROFILES) {
    const shipped = BUILTIN_SYSTEM_PROMPTS.find((p) => p.id === profile.id);
    assert.ok(shipped, `${profile.name} must reach the selectable list`);
    assert.equal(shipped.name, profile.name);
    assert.equal(shipped.prompt, profile.prompt);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test evals/unit/profiles.test.ts`
Expected: FAIL, every test, with a module resolution error for `lib/profiles.ts`.

- [ ] **Step 3: Create the registry**

Create `src/lib/profiles.ts`:

```ts
/**
 * Every built-in prompt profile, and what each one changes about a turn.
 *
 * Behaviour used to be branched on id at the point of use: `useCompletion` compared
 * against two constants to decide whether a prose length cap applied, and the HUD chip
 * compared against the same two to pick a colour. That works for two profiles and not for
 * eight, and it puts a profile's behaviour somewhere other than the profile. Everything a
 * profile changes is declared here; consumers read, they do not branch.
 */

import { CODING_SYSTEM_PROMPT } from "@/config/constants";
import { ANSWER_CONTRACT_INSTRUCTIONS, ASSESSMENT_SYSTEM_PROMPT } from "./assessment";

export type ProfileGroup = "Type it" | "Say it";

/** Named rather than a class string: the mapping to Tailwind belongs to the component. */
export type ProfileAccent =
  | "cyan"
  | "violet"
  | "rose"
  | "indigo"
  | "amber"
  | "slate";

export interface BuiltinProfile {
  /** Permanent. The selection is persisted as this number. */
  id: number;
  name: string;
  /** One line for the picker, under 60 characters. */
  summary: string;
  prompt: string;
  group: ProfileGroup;
  accent: ProfileAccent;
  /**
   * The answer carries code that must survive in full, so a prose length setting is not
   * applied to it (`src/lib/functions/ai-response.function.ts`).
   */
  codeIntent: boolean;
  /** The prompt asks for the fenced `omni` block, so the panel renders it verdict-first. */
  contract: boolean;
}

export const CODE_PROFILE_ID = -1;
export const ASSESSMENT_PROFILE_ID = -2;

/**
  * The order the picker renders groups in. The groups name what the reader does with the
  * answer, because that is the only difference between these profiles that changes their
  * behaviour: a `Say it` answer is one they cannot paste, and it is also the one the panel
  * renders folded and oversized.
  */
export const PROFILE_GROUP_ORDER: ProfileGroup[] = ["Type it", "Say it"];

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    id: CODE_PROFILE_ID,
    name: "Code",
    summary: "Complete runnable code, prose second",
    prompt: CODING_SYSTEM_PROMPT,
    group: "Type it",
    accent: "cyan",
    codeIntent: true,
    contract: false,
  },
  {
    id: ASSESSMENT_PROFILE_ID,
    name: "Assessment",
    summary: "Timed question: the answer first, then why",
    prompt: ASSESSMENT_SYSTEM_PROMPT,
    group: "Type it",
    accent: "violet",
    codeIntent: true,
    contract: true,
  },
];

export const profileById = (id: number | null): BuiltinProfile | undefined =>
  id === null ? undefined : BUILTIN_PROFILES.find((profile) => profile.id === id);

/**
 * False for a profile the user typed. Their prompt is their own, and inheriting another
 * profile's exemption from the length setting would silently ignore a setting they chose.
 */
export const profileHasCodeIntent = (id: number | null): boolean =>
  profileById(id)?.codeIntent ?? false;

export const profileAccent = (id: number | null): ProfileAccent =>
  profileById(id)?.accent ?? "slate";
```

`ANSWER_CONTRACT_INSTRUCTIONS` is imported for composing the prompts in later tasks and deliberately not re-exported: `src/lib/index.ts` star-exports both `./assessment` and `./profiles`, and a name exported by both is ambiguous.

- [ ] **Step 4: Derive the selectable list from the registry**

Replace the whole of `src/lib/system-prompts.constants.ts`:

```ts
import { BUILTIN_PROFILES } from "@/lib/profiles";
import { SystemPrompt } from "@/types";

// Built-ins carry negative ids so they can never collide with a SQLite autoincrement
// rowid, which is what lets them sit in the same list, behind the same selection handler,
// as a profile the user typed. The ids themselves live in the registry.
const BUILTIN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * The registry projected into the shape the database path already speaks, so
 * `useSystemPrompts` can concatenate built-ins and user rows without knowing the
 * difference between them.
 */
export const BUILTIN_SYSTEM_PROMPTS: SystemPrompt[] = BUILTIN_PROFILES.map(
  (profile) => ({
    id: profile.id,
    name: profile.name,
    prompt: profile.prompt,
    created_at: BUILTIN_TIMESTAMP,
    updated_at: BUILTIN_TIMESTAMP,
  })
);

export const isBuiltinSystemPrompt = (id: number): boolean => id < 0;
```

- [ ] **Step 5: Export the registry from the barrel**

Append to `src/lib/index.ts`:

```ts
export * from "./profiles";
```

`CODE_PROFILE_ID` and `ASSESSMENT_PROFILE_ID` now come from `./profiles` and are no longer exported by `./system-prompts.constants`, so `export *` on both files does not collide. Existing importers of `@/lib` keep working unchanged.

- [ ] **Step 6: Run the tests**

Run: `node --test evals/unit/profiles.test.ts && npm run eval:test`
Expected: PASS. The pre-existing test in `evals/unit/response-length.test.ts` named "the Code profile is shipped as a selectable built-in" must still pass, because `BUILTIN_SYSTEM_PROMPTS` keeps its shape.

- [ ] **Step 7: Replace the hardcoded id check in useCompletion**

In `src/hooks/useCompletion.ts`, replace the block that begins with the comment `// These four rewrite the turn into a request for code` and ends at the close of the `codeIntent` assignment with:

```ts
      // These four rewrite the turn into a request for code, so a prose sentence cap on
      // the answer is a request to truncate a diff. /fix, /explain, /summarize and
      // /translate are prose commands and are deliberately absent. Whether the selected
      // profile says the same thing about every turn is the profile's own business now,
      // declared in src/lib/profiles.ts rather than branched on here.
      const selectedProfileId = safeLocalStorage.getItem(
        STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID
      );
      const codeIntent =
        profileHasCodeIntent(
          selectedProfileId === null ? null : Number(selectedProfileId)
        ) ||
        matches("/answer") ||
        matches("/code") ||
        matches("/refactor") ||
        matches("/commit") ||
        matches("/regex");
```

Then update the `@/lib` import block near the top of the file: remove `CODE_PROFILE_ID` and `ASSESSMENT_PROFILE_ID`, add `profileHasCodeIntent`. Leave `ANSWER_CONTRACT_INSTRUCTIONS` in place, it is still used by `/answer`.

- [ ] **Step 8: Replace the hardcoded accent in ProfileChip**

In `src/pages/app/components/completion/ProfileChip.tsx`, replace the import of `ASSESSMENT_PROFILE_ID, CODE_PROFILE_ID, isBuiltinSystemPrompt` from `@/lib` with `isBuiltinSystemPrompt, profileAccent, ProfileAccent`, and replace the `accentFor` function with:

```ts
/** The registry names the accent; the mapping to Tailwind classes belongs here. */
const ACCENT_CLASSES: Record<ProfileAccent, string> = {
  cyan: "border-cyan-600/40 text-cyan-700 dark:border-cyan-400/40 dark:text-cyan-300",
  violet:
    "border-violet-500/40 text-violet-700 dark:border-violet-400/40 dark:text-violet-300",
  rose: "border-rose-500/40 text-rose-700 dark:border-rose-400/40 dark:text-rose-300",
  indigo:
    "border-indigo-500/40 text-indigo-700 dark:border-indigo-400/40 dark:text-indigo-300",
  amber: "border-amber-500/40 text-amber-700 dark:border-amber-400/40 dark:text-amber-300",
  slate: "border-input/40 text-muted-foreground",
};
```

Replace the single use, `accentFor(selectedPromptId)`, with `ACCENT_CLASSES[profileAccent(selectedPromptId)]`.

- [ ] **Step 9: Verify nothing regressed**

Run each, expecting no output from the typechecks and all green from the rest:

```bash
npx tsc --noEmit
npm run eval:typecheck
npm run eval:test
# in another shell: OMNI_HARNESS=1 npx vite --port 1420 --strictPort
npm run hud:probe
npm run answer:probe
```

- [ ] **Step 10: Commit**

```bash
git add src/lib/profiles.ts src/lib/system-prompts.constants.ts src/lib/index.ts \
  src/hooks/useCompletion.ts src/pages/app/components/completion/ProfileChip.tsx \
  evals/unit/profiles.test.ts
git commit -m "refactor(profiles): declare profile behaviour instead of branching on id"
```

---

### Task 2: A picker that survives eight profiles

**Files:**
- Modify: `src/pages/app/components/completion/ProfileChip.tsx` (the `PopoverContent` body)
- Modify: `dev-harness/probe.mjs` (after the existing profile menu checks)

**Interfaces:**
- Consumes: `PROFILE_GROUP_ORDER`, `profileById` from `src/lib/profiles.ts` (Task 1).
- Produces: a menu with `data-slot="profile-menu"`, group headings with `data-slot="profile-group"`, summaries with `data-slot="profile-summary"`, and options that keep `role="option"`.

The menu today is a flat `w-56` list with no height limit. Eight built-ins plus a user's own profiles will run past the bottom of the screen with nothing to scroll, and the names alone do not say what a profile changes.

- [ ] **Step 1: Write the failing probe checks**

In `dev-harness/probe.mjs`, immediately after the existing check named `"the window grows to fit the profile menu"`, add:

```javascript
  const chipMenuShape = await page.evaluate(() => {
    const menu = document.querySelector('[data-slot="profile-menu"]');
    const options = [...document.querySelectorAll('[role="option"]')];
    return {
      groups: [...document.querySelectorAll('[data-slot="profile-group"]')].map((g) =>
        g.textContent.trim()
      ),
      options: options.length,
      summaries: options.filter((o) =>
        o.querySelector('[data-slot="profile-summary"]')
      ).length,
      scrolls: menu ? getComputedStyle(menu).overflowY : null,
      maxHeight: menu ? getComputedStyle(menu).maxHeight : null,
    };
  });

  record(
    "the profile menu groups its options",
    chipMenuShape.groups.length >= 2,
    `groups=${JSON.stringify(chipMenuShape.groups)}`
  );
  record(
    "every profile option explains itself in one line",
    chipMenuShape.options > 0 && chipMenuShape.summaries === chipMenuShape.options,
    `${chipMenuShape.summaries}/${chipMenuShape.options} options carry a summary`
  );
  record(
    "the profile menu scrolls rather than running off the screen",
    chipMenuShape.scrolls === "auto" || chipMenuShape.scrolls === "scroll",
    `overflow-y=${chipMenuShape.scrolls} max-height=${chipMenuShape.maxHeight}`
  );
```

- [ ] **Step 2: Run the probe to verify it fails**

Run, with `OMNI_HARNESS=1 npx vite --port 1420 --strictPort` in another shell:

```bash
npm run hud:probe
```

Expected: three FAILs — `groups=[]`, `0/2 options carry a summary`, `overflow-y=visible`.

- [ ] **Step 3: Add the option row component**

In `src/pages/app/components/completion/ProfileChip.tsx`, add above `export const ProfileChip`:

```tsx
const ProfileOption = ({
  name,
  summary,
  active,
  onSelect,
}: {
  name: string;
  summary: string;
  active: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    role="option"
    aria-selected={active}
    onClick={onSelect}
    className={`flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
      active ? "bg-primary/15" : "hover:bg-primary/10"
    }`}
  >
    <span className="min-w-0">
      <span className="block truncate text-xs">{name}</span>
      <span
        data-slot="profile-summary"
        className="block truncate text-[10px] text-muted-foreground"
      >
        {summary}
      </span>
    </span>
    {active && <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
  </button>
);
```

- [ ] **Step 4: Group, describe and bound the menu**

Replace the `PopoverContent` body (everything between the opening and closing `PopoverContent` tags) with:

```tsx
        <div
          data-slot="profile-menu"
          role="listbox"
          aria-label="Prompt profile"
          className="max-h-[320px] overflow-y-auto"
        >
          {PROFILE_GROUP_ORDER.map((group) => {
            const inGroup = prompts.filter(
              (prompt) => profileById(prompt.id)?.group === group
            );
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <div
                  data-slot="profile-group"
                  className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
                >
                  {group}
                </div>
                {inGroup.map((prompt) => (
                  <ProfileOption
                    key={prompt.id}
                    name={prompt.name}
                    summary={profileById(prompt.id)?.summary ?? ""}
                    active={prompt.id === selectedPromptId}
                    onSelect={() => {
                      handleSelectPrompt(prompt.id);
                      setOpen(false);
                    }}
                  />
                ))}
              </div>
            );
          })}

          {/* Anything the user typed has no registry entry, so it has no group either. */}
          {prompts.some((prompt) => !profileById(prompt.id)) && (
            <div>
              <div
                data-slot="profile-group"
                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
              >
                Yours
              </div>
              {prompts
                .filter((prompt) => !profileById(prompt.id))
                .map((prompt) => (
                  <ProfileOption
                    key={prompt.id}
                    name={prompt.name}
                    summary="Your own prompt"
                    active={prompt.id === selectedPromptId}
                    onSelect={() => {
                      handleSelectPrompt(prompt.id);
                      setOpen(false);
                    }}
                  />
                ))}
            </div>
          )}
        </div>
```

Widen the popover so a summary fits: change `className="w-56 p-1"` to `className="w-72 p-1"`. Update the `@/lib` import to bring in `PROFILE_GROUP_ORDER` and `profileById`, and drop `isBuiltinSystemPrompt`, which the new option row no longer shows.

- [ ] **Step 5: Run the probe to verify it passes**

Run: `npm run hud:probe`
Expected: PASS on all three new checks, and the two existing profile-menu checks still pass.

- [ ] **Step 6: Commit**

```bash
git add src/pages/app/components/completion/ProfileChip.tsx dev-harness/probe.mjs
git commit -m "feat(hud): group the profile menu and give each profile a summary"
```

---

### Task 3: The `speak` shape, Live Interview and Behavioral

**Files:**
- Modify: `src/lib/assessment.ts` (`AnswerShape`, `SHAPES`, add `SPEAK_SHAPE_OVERRIDE` and `DIAGRAM_SHAPE_OVERRIDE`)
- Modify: `src/components/AnswerCard/index.tsx` (`SHAPE_STYLES`, headline sizing, disclosure default, copy payload)
- Modify: `src/lib/profiles.ts` (two new profiles)
- Modify: `evals/unit/assessment.test.ts`
- Modify: `evals/unit/profiles.test.ts`
- Modify: `dev-harness/answer-probe.mjs` (a `speak` case)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `AnswerShape` now includes `"speak"` and `"diagram"`; `SPEAK_SHAPE_OVERRIDE: string`; `DIAGRAM_SHAPE_OVERRIDE: string`; registry ids `-3` (Live Interview) and `-6` (Behavioral).

An interview answer is said out loud. Markdown, code fences and a three-paragraph structure are all wrong for that, and the panel should show one sentence large enough to read while looking away from the screen. Both new shapes land here because they are the same edit to the same three constants; the profile that uses `diagram` is Task 4.

- [ ] **Step 1: Write the failing parser tests**

Append to `evals/unit/assessment.test.ts`:

```ts
test("a spoken answer is a shape of its own", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    [
      "```omni",
      "shape: speak",
      "answer: I'd reach for a hash map, because the lookup has to be constant time.",
      "confidence: high",
      "```",
      "",
      "If they push on memory, the fallback is sorting first and using two pointers.",
    ].join("\n")
  );

  assert.ok(parsed);
  assert.equal(parsed.shape, "speak");
  assert.match(parsed.headline, /hash map/);
  assert.match(parsed.body, /two pointers/);
});

test("a design answer is a shape of its own", async () => {
  const { parseAnswer } = await load();
  const parsed = parseAnswer(
    [
      "```omni",
      "shape: diagram",
      "answer: Fan out on write",
      "```",
      "",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
    ].join("\n")
  );
  assert.ok(parsed);
  assert.equal(parsed.shape, "diagram");
});

test("the two declared-only shapes are never inferred", async () => {
  const { parseAnswer } = await load();
  // `speak` and `diagram` change how the panel reads an answer, so a model that forgot to
  // declare one must fall back to a shape that renders everything, not to one that folds
  // the body away.
  const parsed = parseAnswer(
    ["```omni", "answer: no shape declared", "```", "", "Some prose with no fences."].join(
      "\n"
    )
  );
  assert.ok(parsed);
  assert.ok(["prose", "code", "files", "choice"].includes(parsed.shape));
});
```

- [ ] **Step 2: Write the failing profile tests**

Append to `evals/unit/profiles.test.ts`:

```ts
test("the Live Interview profile answers out loud, not on the page", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "Live Interview");
  assert.ok(profile, "a built-in named Live Interview must ship");
  assert.equal(profile.id, -3);
  assert.equal(profile.group, "Say it");
  assert.equal(profile.contract, true);
  // The whole point of the profile: the answer is spoken, so it must forbid the markdown
  // the rest of the app is built to render.
  assert.match(profile.prompt, /shape: speak/);
  assert.match(profile.prompt, /markdown/i);
  assert.match(profile.prompt, /out loud|aloud|spoken/i);
});

test("the Behavioral profile asks for the four STAR parts by name", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "Behavioral");
  assert.ok(profile, "a built-in named Behavioral must ship");
  assert.equal(profile.id, -6);
  for (const part of ["Situation", "Task", "Action", "Result"]) {
    assert.ok(profile.prompt.includes(part), `Behavioral must name ${part}`);
  }
  // A fabricated metric is the one thing that loses the room.
  assert.match(profile.prompt, /invent|fabricat/i);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `node --test evals/unit/assessment.test.ts evals/unit/profiles.test.ts`
Expected: FAIL — `parsed.shape` is `prose` rather than `speak`, and no profile named Live Interview exists.

- [ ] **Step 4: Add the shapes to the parser**

In `src/lib/assessment.ts`, replace the `AnswerShape` declaration and its doc comment with:

```ts
/**
 * Six shapes cover every task an assessment or an interview throws at the reader, and
 * each one wants a different thing on screen first:
 * - `choice`   the option letters (multiple choice, matrix, output-only)
 * - `code`     one runnable block (single function, recovery, bugfix, SQL, regex)
 * - `files`    several blocks, each belonging to a path (filesystem, frontend)
 * - `prose`    text to read or transcribe (writing, conversation)
 * - `speak`    a sentence to say out loud, with the rest held back
 * - `diagram`  a design that leads with its graph
 */
export type AnswerShape =
  | "choice"
  | "code"
  | "files"
  | "prose"
  | "speak"
  | "diagram";
```

and the `SHAPES` array with:

```ts
const SHAPES: AnswerShape[] = [
  "choice",
  "code",
  "files",
  "prose",
  "speak",
  "diagram",
];
```

`inferShape` is left alone on purpose: it returns only `choice`, `code`, `files` or `prose`, so an undeclared shape can never fall into one that folds the body away.

Then append, after `ANSWER_CONTRACT_INSTRUCTIONS`:

```ts
/**
 * Appended by the profiles that pin a shape the generic contract does not offer. Kept as
 * an override rather than a fifth and sixth entry in the shape menu above: an assessment
 * answer must never come back as `speak`, and a spoken answer must never come back as
 * `files`.
 */
export const SPEAK_SHAPE_OVERRIDE = [
  "Override: `shape` is always `speak` on this profile. Ignore the other shapes.",
  "`answer` is the single sentence to say out loud, in first person, plain spoken English:",
  "no markdown, no bullets, no code fences, no headings. Aim for what fits in about fifteen",
  "seconds. Everything after the block is what to say only if they follow up, one short",
  "line per point.",
].join("\n");

export const DIAGRAM_SHAPE_OVERRIDE = [
  "Override: `shape` is always `diagram` on this profile. Ignore the other shapes.",
  "`answer` is the one-line thesis of the design. Immediately after the block, before any",
  "prose, emit a ```mermaid graph of the architecture. Prose comes after the graph.",
].join("\n");
```

- [ ] **Step 5: Teach the panel the two shapes**

In `src/components/AnswerCard/index.tsx`, add to `SHAPE_STYLES`:

```ts
  speak: {
    label: "Say this",
    surface:
      "border-rose-500/25 bg-rose-500/[0.06] dark:border-rose-400/25 dark:bg-rose-400/[0.08]",
    accent: "text-rose-700 dark:text-rose-300",
  },
  diagram: {
    label: "Design",
    surface:
      "border-indigo-500/25 bg-indigo-500/[0.06] dark:border-indigo-400/25 dark:bg-indigo-400/[0.08]",
    accent: "text-indigo-700 dark:text-indigo-300",
  },
```

Replace the disclosure default so a spoken answer also starts folded:

```ts
  // `choice` and `speak` are the shapes whose payload fits in the rail entirely, so the
  // rest starts folded: the reader wants the letter or the sentence, and opens the
  // argument only when it surprises them.
  const [showBody, setShowBody] = useState(
    answer.shape !== "choice" && answer.shape !== "speak"
  );
```

Replace the copy payload so the shapes without code copy their headline:

```ts
  // Copying the letter or the sentence is the whole job on those shapes; on a code answer
  // it is the first block, which is the part being transcribed into the editor.
  const copiesHeadline =
    answer.shape === "choice" ||
    answer.shape === "prose" ||
    answer.shape === "speak" ||
    answer.shape === "diagram";
  const copyPayload = copiesHeadline
    ? answer.headline
    : collectCodeBlocks(answer.body)[0]?.code || answer.headline;
```

Replace the headline sizing so a spoken sentence is readable while looking away:

```tsx
          <p
            data-slot="answer-headline"
            className={
              answer.shape === "choice" && headlineIsShort
                ? "mt-1 break-words font-mono text-2xl font-semibold leading-tight text-foreground"
                : answer.shape === "speak"
                ? "mt-1 break-words text-lg leading-snug text-foreground"
                : "mt-1 break-words text-sm leading-snug text-foreground/90"
            }
          >
```

Replace the toggle condition so the fold control appears for both folded shapes:

```tsx
      {answer.body && (answer.shape === "choice" || answer.shape === "speak") && (
```

and its label:

```tsx
          {showBody
            ? "Hide the rest"
            : answer.shape === "speak"
            ? "If they follow up"
            : "Show reasoning"}
```

- [ ] **Step 6: Add the two profiles**

In `src/lib/profiles.ts`, add `SPEAK_SHAPE_OVERRIDE` to the import from `./assessment`, then append to `BUILTIN_PROFILES`:

```ts
  {
    id: -3,
    name: "Live Interview",
    summary: "An answer to say out loud, not to read",
    prompt: [
      "You are helping someone in a live technical interview, right now, while the other person is",
      "talking. They cannot read a page. They can glance at one sentence and say it.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      SPEAK_SHAPE_OVERRIDE,
      "",
      "Speak the way a strong candidate speaks: lead with the answer, then one reason. Use `I` and",
      "`we`. Name the tradeoff you are making rather than hiding it. Never read a list of five things",
      "out loud. If the question is ambiguous, the sentence to say is the clarifying question, and the",
      "follow-up lines are the answers for each reading of it.",
      "",
      "When the input is a transcript of what the interviewer said, answer what they asked, not what",
      "you wish they had asked. If you could not make out part of the transcript, say which part in",
      "the follow-up lines rather than guessing at it in the sentence.",
      "",
      "If they asked for code while talking, the sentence is what to say about the approach and the",
      "follow-up lines are the steps in order, one line each, so they can be narrated while typing.",
      "Do not emit a code block: it cannot be read out.",
    ].join("\n"),
    group: "Say it",
    accent: "rose",
    codeIntent: false,
    contract: true,
  },
  {
    id: -6,
    name: "Behavioral",
    summary: "Situation, Task, Action, Result, in your voice",
    prompt: [
      "You are helping someone answer a behavioral interview question out loud.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      SPEAK_SHAPE_OVERRIDE,
      "",
      "Structure the follow-up lines as Situation, Task, Action, Result, one line each, labelled. The",
      "sentence in `answer` is the Result stated first, because that is the part an interviewer",
      "remembers and the rest is how you got there.",
      "",
      "Use only what the user has actually told you about their own history. Where you need a detail",
      "they have not given, leave a bracketed blank such as [team size] rather than inventing a",
      "number: a fabricated metric is the one thing that loses the room. Keep the Action in the first",
      "person singular, because a behavioral answer is about what they did.",
    ].join("\n"),
    group: "Say it",
    accent: "rose",
    codeIntent: false,
    contract: true,
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test evals/unit/assessment.test.ts evals/unit/profiles.test.ts && npx tsc --noEmit`
Expected: PASS, no typecheck output.

- [ ] **Step 8: Add a probe case for the spoken shape**

In `dev-harness/answer-probe.mjs`, add to `CASES`:

```javascript
  speak: [
    "```omni",
    "shape: speak",
    "answer: I'd use a hash map, because the lookup has to stay constant time.",
    "confidence: high",
    "```",
    "",
    "If they push on memory: sort first, then two pointers, O(1) extra space.",
    "If they push on collisions: open addressing keeps it cache friendly.",
  ].join("\n"),
```

and a case block, before the `plain` case:

```javascript
    // Speak: the sentence is the payload and the follow-ups stay folded, because reading a
    // list out loud is exactly what the profile exists to prevent.
    {
      const { context, page } = await answerTurn(browser, CASES.speak);
      const panel = await readPanel(page);
      await shot(page, "answer-speak.png");

      record(
        "a spoken answer leads with the sentence, folded",
        panel.shape === "speak" &&
          /hash map/.test(panel.headline ?? "") &&
          panel.hasToggle &&
          !panel.bodyShown,
        `shape=${panel.shape} toggle=${panel.hasToggle} bodyShown=${panel.bodyShown}`
      );
      record(
        "a spoken answer is set large enough to read at a glance",
        (panel.headlineFontPx ?? 0) >= 17,
        `${panel.headlineFontPx}px`
      );
      record(
        "a spoken answer offers nothing to run",
        !panel.text.includes("Run tests"),
        panel.text.slice(0, 80).replace(/\n/g, " ")
      );

      await context.close();
    }
```

- [ ] **Step 9: Run the probe in both themes**

Run, with the harness dev server up: `npm run answer:probe && HUD_THEME=dark npm run answer:probe`
Expected: all checks pass in both themes. Open `dev-harness/out/answer-speak.png` and confirm the sentence is the largest thing in the panel and the follow-ups are not visible.

- [ ] **Step 10: Commit**

```bash
git add src/lib/assessment.ts src/lib/profiles.ts src/components/AnswerCard/index.tsx \
  evals/unit/assessment.test.ts evals/unit/profiles.test.ts dev-harness/answer-probe.mjs
git commit -m "feat(profiles): answer interviews out loud instead of on the page"
```

---

### Task 4: The System Design profile

**Files:**
- Modify: `src/lib/profiles.ts` (one new profile)
- Modify: `evals/unit/profiles.test.ts`
- Modify: `dev-harness/answer-probe.mjs` (a `diagram` case)

**Interfaces:**
- Consumes: `DIAGRAM_SHAPE_OVERRIDE` and the `diagram` entry in `SHAPE_STYLES`, both added in Task 3.
- Produces: registry id `-5` (System Design).

- [ ] **Step 1: Write the failing test**

Append to `evals/unit/profiles.test.ts`:

```ts
test("the System Design profile asks for numbers and a graph", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "System Design");
  assert.ok(profile, "a built-in named System Design must ship");
  assert.equal(profile.id, -5);
  assert.equal(profile.group, "Say it");
  assert.match(profile.prompt, /shape: diagram/);
  assert.match(profile.prompt, /mermaid/);
  // A design answer with no estimate is a list of boxes. The numbers are the design.
  assert.match(profile.prompt, /estimate|per second|QPS|back-of-envelope/i);
  assert.match(profile.prompt, /bottleneck/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test evals/unit/profiles.test.ts`
Expected: FAIL with "a built-in named System Design must ship".

- [ ] **Step 3: Add the profile**

In `src/lib/profiles.ts`, add `DIAGRAM_SHAPE_OVERRIDE` to the import from `./assessment` and append to `BUILTIN_PROFILES`:

```ts
  {
    id: -5,
    name: "System Design",
    summary: "Numbers, components, tradeoffs, and a graph",
    prompt: [
      "You are helping someone through a system design interview.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      DIAGRAM_SHAPE_OVERRIDE,
      "",
      "After the graph, work in this order and label each part: Requirements, both functional and",
      "not. Estimates, as a back-of-envelope calculation with the arithmetic shown, because a design",
      "with no numbers is a list of boxes. Components, one line each. Data model, only where the",
      "choice is contested. Tradeoffs, stated as what you are giving up. Bottleneck, naming the one",
      "component that fails first and what you would do about it.",
      "",
      "Prefer the boring choice and say why. Do not reach for a queue, a cache or a shard until the",
      "estimate you just wrote says you need one. If the question does not pin down scale, pick a",
      "number, say you picked it, and design for that.",
      "",
      "Keep the graph small enough to talk through: eight nodes at most, labelled with what they are",
      "rather than with a product name. A diagram nobody can narrate is a diagram that does not help.",
    ].join("\n"),
    group: "Say it",
    accent: "indigo",
    codeIntent: false,
    contract: true,
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test evals/unit/profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a probe case**

In `dev-harness/answer-probe.mjs`, add to `CASES`:

```javascript
  diagram: [
    "```omni",
    "shape: diagram",
    "answer: Fan out on write, with a pull path for the few large accounts",
    "confidence: medium",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  Client-->API",
    "  API-->Queue",
    "  Queue-->Fanout",
    "```",
    "",
    "**Estimates** 10M daily users, 2 posts each, 200 followers average: 4B writes a day.",
  ].join("\n"),
```

and a case block, before the `plain` case:

```javascript
    // Diagram: the graph has to reach the panel as a graph, not as a fenced block of
    // mermaid source the reader has to imagine.
    {
      const { context, page } = await answerTurn(browser, CASES.diagram);
      await page
        .waitForSelector('[data-hud-response] svg, [data-hud-response] pre', {
          timeout: 20_000,
        })
        .catch(() => {});
      const panel = await readPanel(page);
      await shot(page, "answer-diagram.png");

      record(
        "a design answer leads with its thesis",
        panel.shape === "diagram" && /Fan out on write/.test(panel.headline ?? ""),
        `shape=${panel.shape} headline=${JSON.stringify(panel.headline)}`
      );
      record(
        "the design panel fits the HUD width",
        panel.overflowPx === 0,
        `${panel.overflowPx}px of horizontal overflow`
      );

      await context.close();
    }
```

- [ ] **Step 6: Run the probe**

Run: `npm run answer:probe`
Expected: all checks pass. Open `dev-harness/out/answer-diagram.png` and confirm the mermaid graph rendered as a picture rather than as source. If it rendered as source, the thing to check is Streamdown's mermaid control in `src/components/Markdown/index.tsx`, not the profile.

- [ ] **Step 7: Commit**

```bash
git add src/lib/profiles.ts evals/unit/profiles.test.ts dev-harness/answer-probe.mjs
git commit -m "feat(profiles): lead a system design answer with its graph"
```

---

### Task 5: Debug, SQL and Frontend, and the docs

**Files:**
- Modify: `src/lib/profiles.ts` (three new profiles)
- Modify: `evals/unit/profiles.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything Tasks 1 and 3 produced.
- Produces: registry ids `-4` (Debug), `-7` (SQL), `-8` (Frontend). Completes the registry at eight profiles.

These three share a mechanism: an existing shape, `contract: true`, `codeIntent: true`. Only the prompt text differs, so they are one task.

- [ ] **Step 1: Write the failing tests**

Append to `evals/unit/profiles.test.ts`:

```ts
test("the Debug profile forbids rewriting what it was given", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "Debug");
  assert.ok(profile, "a built-in named Debug must ship");
  assert.equal(profile.id, -4);
  assert.equal(profile.codeIntent, true);
  // The Code profile's instinct is to show the whole changed function. On a bugfix that
  // hides the fix inside a rewrite, and the reader cannot tell what actually changed.
  assert.match(profile.prompt, /smallest|minimal/i);
  assert.match(profile.prompt, /root cause/i);
  assert.match(profile.prompt, /do not rewrite|never rewrite|without rewriting/i);
});

test("the SQL profile locks a dialect and refuses an ORM", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "SQL");
  assert.ok(profile, "a built-in named SQL must ship");
  assert.equal(profile.id, -7);
  assert.match(profile.prompt, /MySQL/);
  assert.match(profile.prompt, /PostgreSQL|Postgres/);
  assert.match(profile.prompt, /ORM/);
});

test("the Frontend profile matches the starter code and stays drivable", async () => {
  const { BUILTIN_PROFILES } = await load();
  const profile = BUILTIN_PROFILES.find((p) => p.name === "Frontend");
  assert.ok(profile, "a built-in named Frontend must ship");
  assert.equal(profile.id, -8);
  // CodeSignal hands you a blank file, HackerRank often hands you a React component. A
  // profile that hardcodes either one is wrong on the other platform.
  assert.match(profile.prompt, /starter/i);
  // The graders drive the page with a headless browser, so the markup has to be findable.
  assert.match(profile.prompt, /selector|data-testid/i);
});

test("the registry is complete and every id is accounted for", async () => {
  const { BUILTIN_PROFILES } = await load();
  assert.equal(BUILTIN_PROFILES.length, 8);
  assert.deepEqual(
    BUILTIN_PROFILES.map((p) => p.id).sort((a, b) => b - a),
    [-1, -2, -3, -4, -5, -6, -7, -8]
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test evals/unit/profiles.test.ts`
Expected: four FAILs — three "a built-in named X must ship", and the completeness test reporting 5 rather than 8.

- [ ] **Step 3: Add the three profiles**

Append to `BUILTIN_PROFILES` in `src/lib/profiles.ts`:

```ts
  {
    id: -4,
    name: "Debug",
    summary: "Root cause in one line, then the smallest fix",
    prompt: [
      "You are given code that is wrong, and usually a failing test or an error that says how.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      "Use `shape: code`. `answer` is the root cause in one line, naming the expression that is",
      "wrong and what it does instead of what it should. Not the symptom, and not a category:",
      "`the loop stops at length - 1, so the final row is never appended` rather than `off-by-one`.",
      "",
      "Then show the fix as the smallest change that makes the test pass. Do not rewrite the",
      "function, do not rename anything, do not reformat, and do not improve anything you were not",
      "asked about: a fix hidden inside a rewrite is a fix the reader cannot verify against the",
      "original. Show the changed lines with two or three lines of surrounding context so they can",
      "be placed.",
      "",
      "If the code has more than one bug, fix the one the failing test is about and list the others",
      "in one line each at the end. If you cannot see the failing test, say what you assumed the",
      "expected behaviour was before you assumed it.",
    ].join("\n"),
    group: "Type it",
    accent: "amber",
    codeIntent: true,
    contract: true,
  },
  {
    id: -7,
    name: "SQL",
    summary: "One dialect, query first, plan second",
    prompt: [
      "You are answering a SQL question that will be graded by running it, usually against MySQL or",
      "PostgreSQL.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      "Use `shape: code`. `answer` names the approach in one line, such as `window function over",
      "each customer, filtered to rank 1`.",
      "",
      "Decide the dialect before you write anything and say which one you picked and why, in one",
      "line: MySQL and PostgreSQL disagree about string functions, `LIMIT` and `OFFSET`, upserts,",
      "and window support, and a query that works in one can be a syntax error in the other. If the",
      "question names a dialect, that is the dialect. Never write an ORM call, an ActiveRecord chain",
      "or a query builder: the answer is SQL.",
      "",
      "After the query, give the access path in two or three lines: which index it wants, whether it",
      "will scan, and what changes when the table is large. Prefer a join to a correlated subquery",
      "unless you can say why the subquery is faster here. Quote identifiers only where the dialect",
      "requires it. Check the query against the sample rows in the question before answering.",
    ].join("\n"),
    group: "Type it",
    accent: "amber",
    codeIntent: true,
    contract: true,
  },
  {
    id: -8,
    name: "Frontend",
    summary: "Matches the starter code, drivable by a grader",
    prompt: [
      "You are answering a frontend exercise that is graded by a headless browser driving the page.",
      "",
      ANSWER_CONTRACT_INSTRUCTIONS,
      "",
      "Use `shape: files`, with one fence per file, each labelled with its path.",
      "",
      "Match whatever the starter code already uses. A React component in the editor means the answer",
      "is a React component; an empty index.html means plain HTML, CSS and JavaScript with no build",
      "step, because a grader that opens the file directly cannot resolve a bare module specifier.",
      "Never introduce a dependency the exercise did not already have.",
      "",
      "Give every element the test will interact with a stable hook: a `data-testid`, an id, or a",
      "role and accessible name. A selector that depends on a class used for styling breaks the",
      "moment the styling changes, and the test suite is the grader. Use semantic elements, wire",
      "events with `addEventListener` or the framework's own handler rather than inline attributes,",
      "and keep the DOM the source of truth so the assertions can read state back out of it.",
      "",
      "Handle the empty state and the loading state. Graders test them and candidates forget them.",
    ].join("\n"),
    group: "Type it",
    accent: "amber",
    codeIntent: true,
    contract: true,
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test evals/unit/profiles.test.ts && npx tsc --noEmit`
Expected: PASS, including "the registry is complete and every id is accounted for". No typecheck output.

- [ ] **Step 5: Document the profiles**

In `README.md`, insert above the bullet reading `* **Assessment Answers**: ...`:

```markdown
* **Prompt Profiles**: Eight built-ins, switchable from the chip in the HUD, split by what you do with the answer. Type it: `Code`, `Assessment`, `Debug`, `SQL`, `Frontend`. Say it: `Live Interview`, `Behavioral`, `System Design`.
```

- [ ] **Step 6: Run every gate**

Run, with the harness dev server up in another shell:

```bash
npx tsc --noEmit
npm run eval:typecheck
npm run eval:test
npm run hud:probe
npm run answer:probe
HUD_THEME=dark npm run answer:probe
```

Expected: no typecheck output, all tests pass, all probe checks pass in both themes.

- [ ] **Step 7: Confirm the picker holds eight**

The menu is only open while the probe drives it, so read it from the probe rather than from a still. In the `npm run hud:probe` output above, the check named "the profile menu groups its options" must report both group names, and "every profile option explains itself in one line" must report `8/8` on a fresh profile database.

- [ ] **Step 8: Build and install**

```bash
npm run install:local
```

Then summon the HUD, open the profile chip and select Live Interview. Confirm the chip label and its accent change, and that the menu did not clip.

- [ ] **Step 9: Commit**

```bash
git add src/lib/profiles.ts evals/unit/profiles.test.ts README.md
git commit -m "feat(profiles): add Debug, SQL and Frontend"
```

---

## Self-Review Notes

**Spec coverage.** All six profiles have a task: Live Interview and Behavioral in Task 3, System Design in Task 4, Debug, SQL and Frontend in Task 5. The two supporting concerns — behaviour declared rather than branched, and a picker that survives eight entries — are Tasks 1 and 2 and come first because every later task depends on them.

**Known deferrals, deliberate.**
- The `speak` shape does not read the answer aloud. Text to speech is a separate feature with its own permission and voice questions, and the profile is useful without it.
- The SQL profile gets no Run button, because `src-tauri/src/runner.rs` allowlists only `python3` and `node`. That is correct rather than missing: a MySQL answer cannot be verified against SQLite semantics, and a green check that proved nothing is worse than no check.
- No profile is auto-selected from context. Choosing one is one click, and guessing wrong mid-assessment is expensive.
- Take-home, Concept Quiz, Math and Writing are out of scope by request. No id is reserved for them, so they can be added later at `-9` onward without moving anything that shipped.

**Type consistency.** `BuiltinProfile` is defined in Task 1 and every later task appends rows with exactly those eight fields. The `ProfileAccent` values used in later tasks — `rose`, `indigo`, `amber`, `violet`, `cyan` — are all in the union declared in Task 1, and `ACCENT_CLASSES` in Task 1 Step 8 covers every one of them plus `slate`. `AnswerShape` gains `speak` and `diagram` in Task 3, and both get `SHAPE_STYLES` entries in the same step, so the `Record<AnswerShape, ...>` stays total. `SPEAK_SHAPE_OVERRIDE` and `DIAGRAM_SHAPE_OVERRIDE` are both created in Task 3 Step 4; Task 4 only consumes the second.
