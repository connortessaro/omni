import type { Task } from "../types.ts";

// Omni's request pipeline already supports images (see the `imagesBase64`
// param on fetchAIResponse and the {{IMAGE}} template slot in every curl
// provider in src/config/ai-providers.constants.ts), so these tasks are
// wired the same way the other categories are — they just can't be scored
// with a deterministic string/number check the way code or arithmetic can,
// and there is no vision-capable key on this machine to call one with. See
// grader.gradingPath on each task for how it would be scored with one.
export const visionTasks: Task[] = [
  {
    id: "vision-error-dialog-screenshot",
    category: "vision",
    title: "Diagnose an error from a screenshot",
    prompt:
      "Here is a screenshot of an error dialog on my screen. What is causing this error, " +
      "and how do I fix it?",
    grader: {
      type: "manual",
      gradingPath:
        "Fixture: a PNG of a real stack trace/error dialog checked into evals/fixtures/vision/, " +
        "base64-encoded and passed via imagesBase64. Because the exact text baked into the fixture " +
        "is known ahead of time (e.g. a specific error code), grade deterministically with the " +
        "substring grader against that known fact — treat this as an OCR+reasoning check, not free " +
        "vision QA. A richer secondary signal (does the suggested fix make sense) needs an LLM-judge " +
        "rubric or human review; report that separately from the deterministic fact-check so a flaky " +
        "judge score never masks a solid pass/fail signal.",
    },
  },
  {
    id: "vision-ui-layout-bug",
    category: "vision",
    title: "Spot a CSS layout bug from a screenshot",
    prompt:
      "Here is a screenshot of a broken UI (overlapping elements, misaligned text). What is " +
      "wrong with the layout, and what CSS change would fix it?",
    grader: {
      type: "manual",
      gradingPath:
        "Fixture: a PNG of a deliberately broken layout (e.g. a flex-direction or z-index bug) with " +
        "a known root cause. No single short string reliably captures \"identified the right bug\", " +
        "so grade with an LLM-judge rubric (does the answer name the correct property and a plausible " +
        "fix) rather than substring matching, and treat the score as directional, not pass/fail exact.",
    },
  },
  {
    id: "vision-whiteboard-diagram",
    category: "vision",
    title: "Transcribe and critique a whiteboard architecture diagram",
    prompt:
      "Here is a photo of a whiteboard sketch of a system architecture. Transcribe the " +
      "components and connections, then identify the most likely bottleneck.",
    grader: {
      type: "manual",
      gradingPath:
        "Fixture: a photo of a hand-drawn diagram with a known component list and one intended " +
        "bottleneck (e.g. a single shared database behind five services). Grade transcription " +
        "recall with a substring/checklist grader (did it name each component), and grade the " +
        "bottleneck call with an LLM-judge rubric, since \"most likely bottleneck\" has more than " +
        "one defensible answer.",
    },
  },
];
