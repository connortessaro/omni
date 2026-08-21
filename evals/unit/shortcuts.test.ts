import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrcModule } from "../harness/loadSrcModule.ts";

// Why this exists.
//
// Region capture reads at 0-1.7% character error where a full-screen grab reads
// about 60% of the same code and then stops without saying so. It has to be
// reachable from the keyboard whatever capture mode is saved, so it gets its own
// binding rather than living behind the Settings dropdown.
//
// The shipped defaults are a plain array, so a second action can silently claim a
// key another one already uses: the loser just never fires, with no error. The
// Rust side only checks that each key string parses, and it checks a hardcoded
// copy of the list, so a collision is invisible there. This asserts against the
// real source of truth.

interface ShortcutsModule {
  DEFAULT_SHORTCUT_ACTIONS: Array<{
    id: string;
    name: string;
    description: string;
    defaultKey: { macos: string; windows: string; linux: string };
  }>;
}

const { DEFAULT_SHORTCUT_ACTIONS } = await loadSrcModule<ShortcutsModule>(
  "config/shortcuts.ts"
);

const PLATFORMS = ["macos", "windows", "linux"] as const;

test("no two shipped shortcuts claim the same key", () => {
  for (const platform of PLATFORMS) {
    const seen = new Map<string, string>();
    for (const action of DEFAULT_SHORTCUT_ACTIONS) {
      const key = action.defaultKey[platform];
      const owner = seen.get(key);
      assert.equal(
        owner,
        undefined,
        `on ${platform}, "${key}" is claimed by both ${owner} and ${action.id}`
      );
      seen.set(key, action.id);
    }
  }
});

test("region capture ships its own binding", () => {
  const region = DEFAULT_SHORTCUT_ACTIONS.find(
    (a) => a.id === "screenshot_region"
  );
  assert.ok(region, "screenshot_region must ship a default binding");
  const screenshot = DEFAULT_SHORTCUT_ACTIONS.find((a) => a.id === "screenshot");
  assert.ok(screenshot, "screenshot must ship a default binding");
  for (const platform of PLATFORMS) {
    assert.notEqual(
      region.defaultKey[platform],
      screenshot.defaultKey[platform],
      `the two capture shortcuts collide on ${platform}`
    );
  }
});

test("every shipped id is snake_case, so the Rust dispatch arms match", () => {
  // An id that does not match an arm in handle_shortcut_action falls through to
  // the custom-action branch and emits a different event, which fails silently.
  for (const action of DEFAULT_SHORTCUT_ACTIONS) {
    assert.match(
      action.id,
      /^[a-z][a-z0-9_]*$/,
      `"${action.id}" is not snake_case`
    );
  }
});
