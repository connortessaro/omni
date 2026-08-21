import { CODING_SYSTEM_PROMPT } from "@/config/constants";
import { SystemPrompt } from "@/types";

// Built-ins carry negative ids so they can never collide with a SQLite
// autoincrement rowid, which is what lets them sit in the same list, behind the
// same selection handler, as a profile the user typed.
export const CODE_PROFILE_ID = -1;

const BUILTIN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const BUILTIN_SYSTEM_PROMPTS: SystemPrompt[] = [
  {
    id: CODE_PROFILE_ID,
    name: "Code",
    prompt: CODING_SYSTEM_PROMPT,
    created_at: BUILTIN_TIMESTAMP,
    updated_at: BUILTIN_TIMESTAMP,
  },
];

export const isBuiltinSystemPrompt = (id: number): boolean => id < 0;
