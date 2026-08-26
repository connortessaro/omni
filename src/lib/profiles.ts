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
import { ASSESSMENT_SYSTEM_PROMPT } from "./assessment";

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
