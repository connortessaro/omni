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
import {
  ANSWER_CONTRACT_INSTRUCTIONS,
  ASSESSMENT_SYSTEM_PROMPT,
  SPEAK_SHAPE_OVERRIDE,
} from "./assessment";

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
