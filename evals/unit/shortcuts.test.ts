import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadSrcModule, REPO_ROOT } from "../harness/loadSrcModule.ts";

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
  MODIFIER_CHORDS: Record<string, string>;
  isModifierChord: (key: string) => boolean;
  MODIFIER_CHORD_CODES: Array<{
    key: string;
    codes: [string, string];
    flag: string;
  }>;
}

const {
  DEFAULT_SHORTCUT_ACTIONS,
  MODIFIER_CHORDS,
  MODIFIER_CHORD_CODES,
  isModifierChord,
} = await loadSrcModule<ShortcutsModule>("config/shortcuts.ts");

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

/**
 * The macOS bindings, spelled out. A default is a promise about muscle memory, so
 * moving one should be a deliberate edit here rather than a silent drift in
 * config/shortcuts.ts. Keys that read as `left*+right*` are modifier chords,
 * which the Rust side polls for instead of registering.
 */
const MACOS_DEFAULTS: Record<string, string> = {
  toggle_dashboard: "cmd+shift+backslash",
  toggle_window: "leftalt+rightalt",
  focus_input: "cmd+ctrl+i",
  move_window: "cmd",
  system_audio: "cmd+ctrl+l",
  audio_recording: "leftshift+rightshift",
  screenshot: "leftcmd+rightcmd",
  screenshot_region: "cmd+ctrl+r",
};

test("the shipped macOS defaults are the ones that were chosen", () => {
  const shipped = Object.fromEntries(
    DEFAULT_SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultKey.macos])
  );
  assert.deepEqual(shipped, MACOS_DEFAULTS);
});

test("retuning macOS left Windows and Linux alone", () => {
  const untouched: Record<string, string> = {
    toggle_dashboard: "ctrl+shift+d",
    toggle_window: "ctrl+backslash",
    focus_input: "ctrl+shift+i",
    move_window: "ctrl",
    system_audio: "ctrl+shift+m",
    audio_recording: "ctrl+shift+a",
    screenshot: "ctrl+shift+s",
    screenshot_region: "ctrl+shift+r",
  };
  for (const action of DEFAULT_SHORTCUT_ACTIONS) {
    assert.equal(action.defaultKey.windows, untouched[action.id], action.id);
    assert.equal(action.defaultKey.linux, untouched[action.id], action.id);
  }
});

test("every chord used as a default is a chord the app knows", () => {
  // A key the tables do not agree on is dropped on the floor: it never reaches
  // the plugin, and the poll loop never looks for it.
  for (const action of DEFAULT_SHORTCUT_ACTIONS) {
    const key = action.defaultKey.macos;
    if (!key.startsWith("left")) continue;
    assert.ok(MODIFIER_CHORDS[key], `${key} is missing from MODIFIER_CHORDS`);
  }
});

test("the Rust chord table lists exactly the chords the UI can bind", () => {
  // The poll loop is the only thing that fires a chord and it matches on the key
  // string, so a chord added on one side of the boundary and not the other is
  // silently unreachable: no error, the shortcut just never happens.
  const rust = readFileSync(
    path.join(REPO_ROOT, "src-tauri", "src", "shortcuts.rs"),
    "utf8"
  );
  const declaration = "MODIFIER_CHORDS: &[(&str, u16, u16)] = &[";
  const start = rust.indexOf(declaration);
  assert.notEqual(start, -1, "the Rust chord table has been renamed or moved");
  const table = rust.slice(start, rust.indexOf("];", start));
  const declared = [...table.matchAll(/"([a-z+]+)"/g)].map((match) => match[1]);
  assert.deepEqual(declared, Object.keys(MODIFIER_CHORDS));
});

test("the recorder can capture every chord the app can bind", () => {
  assert.deepEqual(
    MODIFIER_CHORD_CODES.map((chord) => chord.key),
    Object.keys(MODIFIER_CHORDS)
  );
  for (const { key, codes, flag } of MODIFIER_CHORD_CODES) {
    assert.notEqual(codes[0], codes[1], `${key} watches one key twice`);
    assert.match(flag, /^(metaKey|shiftKey|altKey)$/);
  }
});

interface StorageModule {
  migrateLegacyDefaultBindings: (config: {
    bindings: Record<string, { action: string; key: string; enabled: boolean }>;
  }) => boolean;
  getShortcutsConfig: () => {
    bindings: Record<string, { action: string; key: string; enabled: boolean }>;
  };
  validateShortcutKey: (key: string) => boolean;
  formatShortcutKeyForDisplay: (key: string) => string;
}

/**
 * Runs `body` against an empty in-memory localStorage on a fixed platform, then
 * restores the real globals. The storage module reads both on import and on every
 * call, so each case needs its own.
 */
async function withBrowser(
  platform: string,
  body: (env: {
    save: (bindings: Record<string, { action: string; key: string; enabled: boolean }>) => void;
    storage: StorageModule;
  }) => Promise<void> | void
) {
  const descriptors = (["localStorage", "navigator"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  const saved = new Map<string, string>();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform },
  });

  try {
    const storage = await loadSrcModule<StorageModule>(
      "lib/storage/shortcuts.storage.ts"
    );
    const save = (
      bindings: Record<string, { action: string; key: string; enabled: boolean }>
    ) => saved.set("shortcuts", JSON.stringify({ bindings }));
    await body({ save, storage });
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("a binding still on an old default moves to the new one", async () => {
  await withBrowser("MacIntel", ({ save, storage }) => {
    save({
      screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: true },
      toggle_window: { action: "toggle_window", key: "cmd+backslash", enabled: true },
      system_audio: { action: "system_audio", key: "cmd+shift+m", enabled: true },
    });
    const { bindings } = storage.getShortcutsConfig();
    assert.equal(bindings.screenshot.key, "leftcmd+rightcmd");
    assert.equal(bindings.toggle_window.key, "leftalt+rightalt");
    assert.equal(bindings.system_audio.key, "cmd+ctrl+l");
  });
});

test("a binding the user set by hand is left alone", async () => {
  await withBrowser("MacIntel", ({ save, storage }) => {
    save({ screenshot: { action: "screenshot", key: "cmd+alt+s", enabled: true } });
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "cmd+alt+s"
    );
  });
});

test("migrating a binding does not switch it back on", async () => {
  await withBrowser("MacIntel", ({ save, storage }) => {
    save({ screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: false } });
    assert.deepEqual(storage.getShortcutsConfig().bindings.screenshot, {
      action: "screenshot",
      key: "leftcmd+rightcmd",
      enabled: false,
    });
  });
});

test("the migration runs once, so a rebind back to an old key sticks", async () => {
  await withBrowser("MacIntel", ({ save, storage }) => {
    save({ screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: true } });
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "leftcmd+rightcmd"
    );
    // Someone who deliberately wants Cmd+Shift+S back keeps it.
    save({ screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: true } });
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "cmd+shift+s"
    );
  });
});

test("a fresh install is never migrated afterwards", async () => {
  await withBrowser("MacIntel", ({ save, storage }) => {
    // No saved config: this install starts on the current defaults.
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "leftcmd+rightcmd"
    );
    save({ screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: true } });
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "cmd+shift+s"
    );
  });
});

test("Windows and Linux configs are not migrated", async () => {
  await withBrowser("Win32", ({ save, storage }) => {
    save({ screenshot: { action: "screenshot", key: "ctrl+shift+s", enabled: true } });
    assert.equal(
      storage.getShortcutsConfig().bindings.screenshot.key,
      "ctrl+shift+s"
    );
  });
});

test("chords validate and display on macOS only", async () => {
  await withBrowser("MacIntel", ({ storage }) => {
    for (const [key, label] of Object.entries(MODIFIER_CHORDS)) {
      assert.equal(storage.validateShortcutKey(key), true, key);
      assert.equal(storage.formatShortcutKeyForDisplay(key), label, key);
    }
    // A chord has no main key, so the ordinary validator would reject it.
    assert.equal(storage.validateShortcutKey("leftcmd+rightshift"), false);
  });

  await withBrowser("Win32", ({ storage }) => {
    for (const key of Object.keys(MODIFIER_CHORDS)) {
      assert.equal(storage.validateShortcutKey(key), false, key);
    }
  });
});

test("the retuned macOS combos still pass validation", async () => {
  await withBrowser("MacIntel", ({ storage }) => {
    for (const [id, key] of Object.entries(MACOS_DEFAULTS)) {
      if (isModifierChord(key) || id === "move_window") continue;
      assert.equal(storage.validateShortcutKey(key), true, `${id}: ${key}`);
    }
  });
});

test("the migration reports whether it changed anything", async () => {
  await withBrowser("MacIntel", ({ storage }) => {
    const legacy = () => ({
      bindings: {
        screenshot: { action: "screenshot", key: "cmd+shift+s", enabled: true },
      },
    });

    const first = legacy();
    assert.equal(storage.migrateLegacyDefaultBindings(first), true);
    assert.equal(first.bindings.screenshot.key, "leftcmd+rightcmd");

    const second = legacy();
    assert.equal(storage.migrateLegacyDefaultBindings(second), false);
    assert.equal(second.bindings.screenshot.key, "cmd+shift+s");
  });
});
