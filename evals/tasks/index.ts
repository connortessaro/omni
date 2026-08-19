import type { Task } from "../types.ts";
import { codingTasks } from "./coding.tasks.ts";
import { debuggingTasks } from "./debugging.tasks.ts";
import { reasoningTasks } from "./reasoning.tasks.ts";
import { longContextTasks } from "./long-context.tasks.ts";
import { visionTasks } from "./vision.tasks.ts";

export const ALL_TASKS: Task[] = [
  ...codingTasks,
  ...debuggingTasks,
  ...reasoningTasks,
  ...longContextTasks,
  ...visionTasks,
];

export {
  codingTasks,
  debuggingTasks,
  reasoningTasks,
  longContextTasks,
  visionTasks,
};
