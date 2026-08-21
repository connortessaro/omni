import type { Message } from "../src/types/completion.ts";

export type TaskCategory =
  | "coding"
  | "debugging"
  | "reasoning"
  | "long-context"
  | "vision";

export interface CodeExecCall {
  fn: string;
  args: unknown[];
}

export interface CodeExecCase {
  description: string;
  calls: CodeExecCall[];
  expected: unknown[];
}

export interface CodeExecGrader {
  type: "code-exec";
  language: "javascript";
  cases: CodeExecCase[];
}

export interface DebugFixGrader {
  type: "debug-fix";
  language: "javascript";
  cases: CodeExecCase[];
  /**
   * Each entry is satisfied independently (OR). A string entry matches as a
   * substring; an array entry requires every term to appear (AND), which lets a
   * concept be matched without pinning the model to one exact phrasing.
   */
  rootCauseKeywords: (string | string[])[];
}

export interface NumericGrader {
  type: "numeric";
  expected: number;
  tolerance: number;
}

export interface SubstringGrader {
  type: "substring";
  expectedAll: string[];
  caseSensitive?: boolean;
}

export interface ManualGrader {
  type: "manual";
  gradingPath: string;
}

export type Grader =
  | CodeExecGrader
  | DebugFixGrader
  | NumericGrader
  | SubstringGrader
  | ManualGrader;

export interface Task {
  id: string;
  category: TaskCategory;
  title: string;
  prompt: string;
  history?: Message[];
  systemPrompt?: string;
  /**
   * Image fixtures to send with the prompt, as repo-root-relative paths. The runner
   * reads and base64-encodes them, so a task stays a plain data literal.
   *
   * `fetchAIResponse` has always accepted `imagesBase64`, but nothing passed it, so
   * the vision path shipped untested. These make it exercised.
   */
  imageFixtures?: string[];
  grader: Grader;
  knownWeakness?: string;
}
