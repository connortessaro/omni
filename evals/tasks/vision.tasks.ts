import type { Task } from "../types.ts";

// The scenario these exist for: a repo is open in a browser IDE and Omni's only
// view of the code is a screenshot. Screen reading is not a side feature there, it
// is the whole capability, so it needs a pass/fail signal like every other
// category.
//
// These previously carried `manual` graders, which run-eval.ts skips, and
// runTaskAgainstOmni never passed `imagesBase64` — so the vision path shipped with
// no executed coverage at all. Fixtures are real captures of psf/requests open in
// VS Code for the web, taken by dev-harness/ide-capture.mjs, with the on-screen text
// recorded alongside each PNG.
//
// Graded on strings that are in the fixture and are not guessable from the prompt:
// vendored urllib3 import paths and this repo's own constant names. A model that
// cannot read the screenshot cannot produce them.
export const visionTasks: Task[] = [
  {
    id: "vision-read-code-from-browser-ide",
    category: "vision",
    title: "Read source off a screenshot of VS Code in a browser",
    prompt:
      "This is a screenshot of a source file open in a code editor in a web browser. " +
      "Transcribe every line of code that is visible, verbatim, preserving order. " +
      "Output only the code, with no commentary and no line numbers.",
    imageFixtures: ["evals/fixtures/vision/vscode-web-adapters-2x.png"],
    grader: {
      type: "substring",
      expectedAll: [
        "from .packages.urllib3.poolmanager import PoolManager, proxy_from_url",
        "from .packages.urllib3.util import Timeout as TimeoutSauce",
        "from .packages.urllib3.exceptions import ProxyError as _ProxyError",
        "DEFAULT_POOLBLOCK",
        "class BaseAdapter(object):",
      ],
      caseSensitive: true,
    },
  },
  {
    id: "vision-locate-symbol-in-screenshot",
    category: "vision",
    title: "Answer a question about code that is only in a screenshot",
    prompt:
      "The screenshot shows a Python file open in an editor. Which urllib3 exception " +
      "types does this file import, and what is each one aliased to? Answer from the " +
      "screenshot only.",
    imageFixtures: ["evals/fixtures/vision/vscode-web-adapters-2x.png"],
    grader: {
      type: "substring",
      expectedAll: ["_HTTPError", "_ProxyError", "ConnectTimeoutError"],
      caseSensitive: true,
    },
  },
  {
    id: "vision-full-screen-capture-tail",
    category: "vision",
    title: "Read the bottom of a full-screen capture",
    prompt:
      "This is a screenshot of an entire 2560x1600 screen with a source file open in " +
      "an editor. Find the class definition furthest down the visible file and quote " +
      "its `__attrs__` list exactly as written, then quote the first parameter of its " +
      "`__init__` signature.",
    imageFixtures: [
      "evals/fixtures/vision/vscode-web-fullscreen-2560x1600.png",
    ],
    grader: {
      type: "substring",
      expectedAll: ["_pool_block", "DEFAULT_POOLSIZE"],
      caseSensitive: true,
    },
    knownWeakness:
      "A full-screen capture puts ~66 lines of code on screen. Asked to transcribe " +
      "all of it, the model reads roughly the first 60% and stops, with no indication " +
      "that the rest went unread. This task asks about content near the bottom on " +
      "purpose, so that failure shows up as a failure instead of a shorter answer.",
  },
];
