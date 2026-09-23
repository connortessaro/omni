import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components";
import { useSystemPrompts } from "@/hooks";
import {
  PROFILE_GROUP_ORDER,
  profileAccent,
  ProfileAccent,
  profileById,
} from "@/lib";

/**
 * Which prompt profile the next turn will run under, and a way to change it.
 *
 * The profile decides whether an answer comes back as a paragraph or as a verdict, and
 * it used to live only in Omni Space: two windows away from the bar you are typing into,
 * with nothing on screen to say which one was active. On a timed question that is the
 * difference between a letter at 24px and a wall of prose.
 */

/** Wide enough for "Assessment", short enough to leave the prompt its width. */
const CHIP_LABEL_LIMIT = 11;

/** The bar has room for a word, not a sentence. */
const shortLabel = (name: string): string =>
  name.length <= CHIP_LABEL_LIMIT ? name : `${name.slice(0, CHIP_LABEL_LIMIT - 1)}…`;

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
    className={`flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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

export const ProfileChip = () => {
  const { prompts, selectedPromptId, handleSelectPrompt } = useSystemPrompts();
  const [open, setOpen] = useState(false);

  const selected = prompts.find((prompt) => prompt.id === selectedPromptId);
  const label = selected ? shortLabel(selected.name) : "Default";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="profile-chip"
          data-profile-id={selectedPromptId ?? "default"}
          title={`Prompt profile: ${selected?.name ?? "Default"}`}
          className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${ACCENT_CLASSES[profileAccent(selectedPromptId)]}`}
        >
          {label}
          <ChevronDown className="size-2.5 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>

      {/* The window is 54px tall at rest, so Radix's collision handling flips this menu
          upward, off the top of the window, where it is clipped and cannot be reached.
          Worse, a flipped menu sits above the card's bottom edge, which is exactly what
          useWindowResize reads as "nothing measurable is open yet": no resize fires, no
          room below ever appears, and the menu stays flipped forever. The window grows
          to fit whatever opens, so there is no collision to avoid. */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        avoidCollisions={false}
        className="w-72 p-1"
      >
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
      </PopoverContent>
    </Popover>
  );
};
