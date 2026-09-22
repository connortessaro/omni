import { ShortcutAction } from "@/types";

/**
 * Chords of one modifier's left and right key, mapped to their display label.
 * The global shortcut plugin cannot register a modifier on its own, so the Rust
 * side polls for these instead; the keys must match MODIFIER_CHORDS in
 * src-tauri/src/shortcuts.rs. macOS only, since it is the only platform with a
 * distinct right-hand copy of every modifier.
 */
export const MODIFIER_CHORDS: Record<string, string> = {
  "leftcmd+rightcmd": "Left ⌘ + Right ⌘",
  "leftshift+rightshift": "Left ⇧ + Right ⇧",
  "leftalt+rightalt": "Left ⌥ + Right ⌥",
};

export const isModifierChord = (key: string): boolean =>
  MODIFIER_CHORDS[key] !== undefined;

/**
 * How the recorder recognizes a chord: the two KeyboardEvent codes to press, and
 * the modifier flag they raise. Any *other* flag being set means the user is
 * pressing an app shortcut rather than a chord.
 */
export const MODIFIER_CHORD_CODES: Array<{
  key: string;
  codes: [string, string];
  flag: "metaKey" | "shiftKey" | "altKey";
}> = [
  {
    key: "leftcmd+rightcmd",
    codes: ["MetaLeft", "MetaRight"],
    flag: "metaKey",
  },
  {
    key: "leftshift+rightshift",
    codes: ["ShiftLeft", "ShiftRight"],
    flag: "shiftKey",
  },
  {
    key: "leftalt+rightalt",
    codes: ["AltLeft", "AltRight"],
    flag: "altKey",
  },
];

/**
 * The HUD sits on top of whatever app you are actually using, and registering a
 * global shortcut takes the key away from that app. So the macOS defaults avoid
 * the crowded Cmd+Shift prefix: the most-used actions are left+right modifier
 * chords, which nothing on macOS binds, and the rest sit on Cmd+Ctrl.
 */
export const DEFAULT_SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "toggle_dashboard",
    name: "Toggle Dashboard",
    description: "Open/Close the dashboard window",
    defaultKey: {
      macos: "cmd+shift+backslash",
      windows: "ctrl+shift+d",
      linux: "ctrl+shift+d",
    },
    defaultEnabled: false,
  },
  {
    id: "toggle_window",
    name: "Toggle Window",
    description: "Show/Hide the main window (or Double-Tap Right ⇧ for keylogger-proof stealth)",
    defaultKey: {
      macos: "leftalt+rightalt",
      windows: "ctrl+backslash",
      linux: "ctrl+backslash",
    },
    defaultEnabled: true,
  },
  {
    id: "focus_input",
    name: "Refocus Input Box",
    description: "Bring Omni forward and place the cursor in the input area",
    defaultKey: {
      macos: "cmd+ctrl+i",
      windows: "ctrl+shift+i",
      linux: "ctrl+shift+i",
    },
    defaultEnabled: false,
  },
  {
    id: "move_window",
    name: "Move Window",
    description: "Move overlay with arrow keys (hold to move continuously)",
    defaultKey: {
      macos: "cmd",
      windows: "ctrl",
      linux: "ctrl",
    },
    defaultEnabled: false,
  },
  {
    id: "system_audio",
    name: "System Audio",
    description: "Toggle system audio capture",
    defaultKey: {
      macos: "cmd+ctrl+l",
      windows: "ctrl+shift+m",
      linux: "ctrl+shift+m",
    },
    defaultEnabled: false,
  },
  {
    id: "audio_recording",
    name: "Voice Input",
    description: "Start voice recording",
    defaultKey: {
      macos: "leftshift+rightshift",
      windows: "ctrl+shift+a",
      linux: "ctrl+shift+a",
    },
    defaultEnabled: false,
  },
  {
    id: "screenshot",
    name: "Screenshot",
    description: "Capture screenshot",
    defaultKey: {
      macos: "leftcmd+rightcmd",
      windows: "ctrl+shift+s",
      linux: "ctrl+shift+s",
    },
    defaultEnabled: true,
  },
  {
    id: "screenshot_region",
    name: "Capture Region",
    description: "Drag to capture part of the screen, whatever the saved mode is",
    defaultKey: {
      macos: "cmd+ctrl+r",
      windows: "ctrl+shift+r",
      linux: "ctrl+shift+r",
    },
    defaultEnabled: false,
  },
];
