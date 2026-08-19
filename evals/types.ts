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
  rootCauseKeywords: string[];
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
  grader: Grader;
  knownWeakness?: string;
}
