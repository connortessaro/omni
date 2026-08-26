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
