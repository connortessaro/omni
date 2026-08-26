import { Command } from "lucide-react";
import { Card } from "@/components";
import { getPlatform } from "@/lib";

/**
 * The keys that work inside the HUD once it is open.
 *
 * These are not global shortcuts: they are handled by the window that has focus, so they
 * cannot collide with another app and there is nothing to register or rebind. They were
 * also documented nowhere, which meant the only way to find out that Cmd+Enter opens a
 * composer was to read the source.
 */

interface InAppKey {
  keys: string;
  action: string;
  /** When the key does something, since several of them are context-dependent. */
  when: string;
}

const IN_APP_KEYS: InAppKey[] = [
  { keys: "Enter", action: "Send the prompt", when: "in the prompt box" },
  { keys: "Shift + Enter", action: "New line", when: "in the prompt box" },
  {
    keys: "MOD + Enter",
    action: "Expand or collapse the composer",
    when: "in the prompt box",
  },
  {
    keys: "↑ / ↓",
    action: "Cycle recent prompts",
    when: "in the prompt box",
  },
  {
    keys: "↑ / ↓",
    action: "Scroll the answer",
    when: "with an answer open",
  },
  {
    keys: "MOD + K",
    action: "Keep the conversation going between turns",
    when: "with an answer open",
  },
  {
    keys: "Esc",
    action: "Dismiss the answer, the clipboard tip or the command menu",
    when: "anywhere in the HUD",
  },
  {
    keys: "Backspace",
    action: "Remove the last attachment",
    when: "with the prompt box empty",
  },
  {
    keys: "/",
    action: "Open the command menu; Tab or Enter accepts",
    when: "at the start of the prompt",
  },
];

export const InAppKeys = () => {
  const modifier = getPlatform() === "macos" ? "⌘" : "Ctrl";

  return (
    <div id="in-app-keys" className="space-y-4">
      <div>
        <h3 className="text-md lg:text-lg font-semibold flex items-center gap-2">
          <Command className="size-5" />
          In the HUD
        </h3>
        <p className="text-sm text-muted-foreground">
          Fixed keys, handled by the HUD while it has focus. Nothing to register, nothing
          to rebind.
        </p>
      </div>

      <Card className="shadow-none border border-border/70 rounded-xl p-0 overflow-hidden">
        <ul className="divide-y divide-border/60">
          {IN_APP_KEYS.map((key) => (
            <li
              key={`${key.keys}-${key.when}`}
              data-slot="in-app-key"
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm">{key.action}</p>
                <p className="text-xs text-muted-foreground">{key.when}</p>
              </div>
              <kbd className="shrink-0 rounded-md border border-input/50 bg-muted/50 px-2 py-1 font-mono text-xs">
                {key.keys.replace("MOD", modifier)}
              </kbd>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
};
