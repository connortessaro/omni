import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Task } from "../types.ts";
import type { Message } from "../../src/types/completion.ts";
import type { RawProvider, SelectedProvider } from "./providerConfig.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Reads a task's image fixtures. A missing fixture throws rather than running the
 * task without its image: a vision task that silently degrades into a text task
 * would report a pass that means nothing.
 */
export function loadTaskImages(task: Task): string[] {
  return (task.imageFixtures ?? []).map((relativePath) => {
    const absolute = join(REPO_ROOT, relativePath);
    try {
      return readFileSync(absolute).toString("base64");
    } catch (error) {
      throw new Error(
        `Task ${task.id} needs image fixture ${relativePath}, which could not be ` +
          `read from ${absolute}: ${error instanceof Error ? error.message : error}`
      );
    }
  });
}

export interface FetchAIResponseParams {
  provider: RawProvider | undefined;
  selectedProvider: SelectedProvider;
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  signal?: AbortSignal;
}

export interface OmniAiResponseModule {
  fetchAIResponse(params: FetchAIResponseParams): AsyncIterable<string>;
}

export interface TaskRunResult {
  taskId: string;
  responseText: string;
  timedOut: boolean;
  errorText?: string;
  durationMs: number;
}

/**
 * Drives one task through Omni's real fetchAIResponse generator end to end
 * (system-prompt stacking, history splicing, streaming parse all included)
 * and collects the full text. Works identically whether `fetch` is the real
 * global fetch (live run) or a capturing/canned stub (dry run, tests).
 */
export async function runTaskAgainstOmni(
  task: Task,
  omni: OmniAiResponseModule,
  provider: RawProvider,
  selectedProvider: SelectedProvider,
  timeoutMs = 60000
): Promise<TaskRunResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();
  let responseText = "";
  let errorText: string | undefined;

  try {
    for await (const chunk of omni.fetchAIResponse({
      provider,
      selectedProvider,
      systemPrompt: task.systemPrompt,
      history: task.history ?? [],
      userMessage: task.prompt,
      imagesBase64: loadTaskImages(task),
      signal,
    })) {
      responseText += chunk;
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }

  return {
    taskId: task.id,
    responseText,
    timedOut: signal.aborted && responseText === "" && errorText === undefined,
    errorText,
    durationMs: Date.now() - startedAt,
  };
}
