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
  assert.ok(
    ids.every((id) => id < 0),
    "built-in ids must be negative"
  );
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
