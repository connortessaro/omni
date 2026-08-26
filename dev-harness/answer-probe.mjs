// Drives the real HUD through an assessment answer of each shape and checks the
// verdict panel renders it the way a timed reader needs.
//
// probe.mjs covers the bar at rest. This covers the panel that opens over it: the
// contract block must never reach the markdown renderer, the option letters must be
// legible without scrolling, a multi-file answer must offer its file rail, and an
// ordinary chat turn must still render as plain markdown. All four are things a
// parser regression breaks silently, because a wrong panel still looks like a panel.
//
// The provider is scripted through the mock (dev-harness/tauri-mock.js,
// __HARNESS_STREAM__), so nothing is billed and the answer is identical every run.
//
// WebKit on purpose, same as the other probes: the app ships inside WKWebView.
//
// Usage: npm run dev:harness   (in another shell)
//        npm run answer:probe

import { webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";

/** Both themes ship, and the accents have to stay readable in each. HUD_THEME=dark. */
const THEME = process.env.HUD_THEME ?? "light";

/** The HUD window size configured in tauri.conf.json. */
const HUD_WIDTH = 1200;
const HUD_RESTING_HEIGHT = 54;

/** Tall enough for the panel; the native window grows the same way. */
const HUD_OPEN_HEIGHT = 620;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

/** OpenAI-compatible SSE, which is what the gemini provider streams. */
const sseChunks = (text) =>
  text
    .split("\n")
    .map(
      (line, index) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content: index === 0 ? line : `\n${line}` } }],
        })}\n\n`
    );

const CASES = {
  choice: [
    "```omni",
    "shape: choice",
    "answer: B",
    "options: A, B*, C, D",
    "confidence: high",
    "```",
    "",
    "`sort` coerces each element to a string before comparing, so `[10, 9]` sorts to",
    "`[10, 9]`. Option B is the only one that passes a comparator.",
  ].join("\n"),

  code: [
    "```omni",
    "shape: code",
    "answer: Two pointers from both ends, O(n) time and O(1) space",
    "confidence: high",
    "```",
    "",
    "```python",
    "def two_sum_sorted(nums, target):",
    "    left, right = 0, len(nums) - 1",
    "    while left < right:",
    "        total = nums[left] + nums[right]",
    "        if total == target:",
    "            return [left, right]",
    "        if total < target:",
    "            left += 1",
    "        else:",
    "            right -= 1",
    "    return []",
    "```",
  ].join("\n"),

  files: [
    "```omni",
    "shape: files",
    "answer: src/inventory.py and tests/test_inventory.py",
    "confidence: medium",
    "```",
    "",
    "**src/inventory.py**",
    "```python",
    "def restock(item, count):",
    "    if count < 0:",
    "        raise ValueError('count must be positive')",
    "    item.quantity += count",
    "    return item.quantity",
    "```",
    "",
    "**tests/test_inventory.py**",
    "```python",
    "def test_restock_rejects_negative():",
    "    with pytest.raises(ValueError):",
    "        restock(Item(), -1)",
    "```",
  ].join("\n"),

  runnable: [
    "```omni",
    "shape: files",
    "answer: src/solution.py and tests/test_solution.py",
    "confidence: high",
    "```",
    "",
    "**src/solution.py**",
    "```python",
    "def add(a, b):",
    "    return a + b",
    "```",
    "",
    "**tests/test_solution.py**",
    "```python",
    "from solution import add",
    "assert add(2, 2) == 4",
    "```",
  ].join("\n"),

  speak: [
    "```omni",
    "shape: speak",
    "answer: I'd use a hash map, because the lookup has to stay constant time.",
    "confidence: high",
    "```",
    "",
    "If they push on memory: sort first, then two pointers, O(1) extra space.",
    "If they push on collisions: open addressing keeps it cache friendly.",
  ].join("\n"),

  diagram: [
    "```omni",
    "shape: diagram",
    "answer: Fan out on write, with a pull path for the few large accounts",
    "confidence: medium",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  Client-->API",
    "  API-->Queue",
    "  Queue-->Fanout",
    "```",
    "",
    "**Estimates** 10M daily users, 2 posts each, 200 followers average: 4B writes a day.",
  ].join("\n"),

  // Long enough to overflow the panel's 488px cap several times over, which is the
  // only way to see whether the panel scrolls at all.
  long: [
    "```omni",
    "shape: prose",
    "answer: The parser drops the last row.",
    "confidence: high",
    "```",
    "",
    ...Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i + 1} of an answer far taller than the panel.\n`
    ),
  ].join("\n"),

  plain: [
    "The parser drops the last row because the loop stops one short of the end.",
    "",
    "```python",
    "for row in rows[:-1]:",
    "    emit(row)",
    "```",
  ].join("\n"),
};

/**
 * Installed before app code: seeds a provider so a turn can fire, and arms the
 * scripted stream. The key is a placeholder because the mock never sends the
 * request anywhere, and seeding a real one would put a credential in a probe.
 */
const initScript = ({ chunks, theme, run }) => {
  localStorage.setItem("theme", theme);
  if (run) window.__HARNESS_RUN__ = run;
  localStorage.setItem(
    "curl_selected_ai_provider",
    JSON.stringify({
      provider: "gemini",
      variables: { api_key: "harness-placeholder", model: "gemini-2.5-flash" },
    })
  );
  window.__HARNESS_STREAM__ = {
    firstChunkDelayMs: 0,
    chunkIntervalMs: 0,
    chunks,
  };
};

/** One turn, from an empty prompt to a settled panel. */
const answerTurn = async (browser, body, run) => {
  const context = await browser.newContext({
    viewport: { width: HUD_WIDTH, height: HUD_RESTING_HEIGHT },
  });
  await context.addInitScript(initScript, {
    chunks: sseChunks(body),
    theme: THEME,
    run,
  });

  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 15_000 });

  // Cold vite compiles modules on demand, so the first paint of a freshly edited app can
  // race the height measurement and record a spurious open-then-collapse. Scoping the log
  // to the turn is also what makes "one answer does not thrash" measure one answer.
  await page.evaluate(() => window.__HARNESS__?.reset());

  // The argument matters: with a bare `/answer` the slash menu is still open, and
  // Enter accepts the command instead of sending the turn.
  await page.locator("textarea").click();
  await page.locator("textarea").fill("/answer the question on screen");
  await page.keyboard.press("Enter");

  // The panel's scroll region collapses to zero height at the resting window size,
  // so WebKit reports no text inside it until the viewport grows. The native window
  // really does grow; the probe has to mirror that.
  await page.setViewportSize({ width: HUD_WIDTH, height: HUD_OPEN_HEIGHT });
  await page.waitForSelector("[data-hud-response]", { timeout: 20_000 });
  await page.waitForFunction(
    () => !document.querySelector("[data-hud-loading]"),
    { timeout: 20_000 }
  );

  // Code blocks are highlighted asynchronously, so the panel shows a spinner where
  // the code will be for a beat after the stream ends. Reading it before then
  // measures the spinner.
  if (body.includes("\n```") && !body.trimStart().startsWith("```omni\nshape: choice")) {
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("[data-hud-response] pre")].some(
            (node) => node.innerText.trim().length > 0
          ),
        { timeout: 20_000 }
      )
      .catch(() => {});
  }

  return { context, page };
};

const readPanel = (page) =>
  page.evaluate(() => {
    const pick = (selector) => document.querySelector(selector);
    const verdict = pick('[data-slot="answer-verdict"]');
    const headline = pick('[data-slot="answer-headline"]');
    const response = pick("[data-hud-response]");
    const viewport = document.querySelector(
      '[data-radix-popper-content-wrapper] [data-slot="scroll-area-viewport"]'
    );
    const options = [
      ...document.querySelectorAll('[data-slot="answer-options"] li'),
    ].map((node) => ({
      label: node.textContent.trim(),
      selected: node.dataset.selected === "true",
    }));

    return {
      hasCard: Boolean(pick('[data-slot="answer-card"]')),
      shape: verdict?.dataset.shape ?? null,
      headline: headline?.textContent.trim() ?? null,
      headlineFontPx: headline
        ? Math.round(parseFloat(getComputedStyle(headline).fontSize))
        : null,
      options,
      bodyShown: Boolean(pick('[data-slot="answer-body"]')),
      hasToggle: Boolean(pick('[data-slot="answer-body-toggle"]')),
      railPaths: [
        ...document.querySelectorAll('[data-slot="answer-file-rail"] button'),
      ].map((node) => node.textContent.trim()),
      text: response?.innerText ?? "",
      viewportClientH: viewport?.clientHeight ?? null,
      viewportScrollH: viewport?.scrollHeight ?? null,
      resizeHeights: (window.__HARNESS__?.callsFor("set_window_height") ?? []).map(
        (call) => call.args?.height
      ),
      // The panel is as wide as the HUD and cannot scroll sideways, so anything wider
      // its own box is text the reader cannot reach.
      overflowPx: response
        ? Math.max(0, response.scrollWidth - response.clientWidth)
        : 0,
    };
  });

const shot = (page, file) =>
  page.screenshot({
    path: join(OUT, THEME === "light" ? file : file.replace(".png", `-${THEME}.png`)),
  });

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await webkit.launch();

  try {
    // Choice: the letter is the payload, so it is set large, the option chips show
    // which of the four it was, and the argument stays folded behind a toggle.
    {
      const { context, page } = await answerTurn(browser, CASES.choice);
      const panel = await readPanel(page);
      await shot(page, "answer-choice.png");

      record(
        "a choice answer leads with the letter",
        panel.shape === "choice" &&
          panel.headline === "B" &&
          panel.headlineFontPx >= 20,
        `shape=${panel.shape} headline=${JSON.stringify(panel.headline)} ${panel.headlineFontPx}px`
      );
      record(
        "every option is shown and only the correct one is marked",
        panel.options.length === 4 &&
          panel.options.filter((o) => o.selected).length === 1 &&
          panel.options.find((o) => o.selected)?.label === "B",
        JSON.stringify(panel.options)
      );
      record(
        "the reasoning starts folded behind a toggle",
        panel.hasToggle && !panel.bodyShown,
        `toggle=${panel.hasToggle} bodyShown=${panel.bodyShown}`
      );
      record(
        "the contract block never reaches the renderer",
        !/shape:|confidence:|```omni/.test(panel.text),
        panel.text.slice(0, 120).replace(/\n/g, " ")
      );
      record(
        "the panel fits the HUD width",
        panel.overflowPx === 0,
        `${panel.overflowPx}px of horizontal overflow`
      );
      await context.close();
    }

    // Code: the solution is the payload, so the body is open from the start and the
    // headline drops to a sentence rather than competing with it.
    {
      const { context, page } = await answerTurn(browser, CASES.code);
      const panel = await readPanel(page);
      await shot(page, "answer-code.png");

      record(
        "a code answer opens with its solution visible",
        panel.shape === "code" && panel.bodyShown && !panel.hasToggle,
        `shape=${panel.shape} bodyShown=${panel.bodyShown}`
      );
      record(
        "the code itself is rendered, not described",
        /two_sum_sorted/.test(panel.text) && /left, right = 0/.test(panel.text),
        panel.text.slice(0, 120).replace(/\n/g, " ")
      );
      record(
        "the code panel fits the HUD width",
        panel.overflowPx === 0,
        `${panel.overflowPx}px of horizontal overflow`
      );
      await context.close();
    }

    // Files: several blocks, so the rail names each path and the reader jumps rather
    // than scrolls to find the file they are pasting into.
    {
      const { context, page } = await answerTurn(browser, CASES.files);
      const panel = await readPanel(page);
      await shot(page, "answer-files.png");

      record(
        "a multi-file answer offers a rail of its paths",
        panel.shape === "files" &&
          panel.railPaths.join(",") ===
            "src/inventory.py,tests/test_inventory.py",
        `shape=${panel.shape} rail=${JSON.stringify(panel.railPaths)}`
      );
      record(
        "the files panel fits the HUD width",
        panel.overflowPx === 0,
        `${panel.overflowPx}px of horizontal overflow`
      );
      await context.close();
    }

    // Runnable: the whole point of the button is that it runs the file that does the
    // checking. Running the solution instead reports a clean pass on an answer nobody
    // verified, which reads exactly like a real pass.
    {
      const { context, page } = await answerTurn(browser, CASES.runnable, {
        exit_code: 0,
        stdout: "2 passed",
        duration_ms: 31,
      });

      const button = page.locator('[data-slot="answer-run-button"]');
      record(
        "a runnable answer offers to run its tests",
        await button.isVisible(),
        `button visible=${await button.isVisible()}`
      );

      await button.click();
      await page.waitForSelector('[data-slot="answer-run-result"]', { timeout: 10_000 });

      const run = await page.evaluate(() => ({
        sent: window.__LAST_RUN__,
        status: document
          .querySelector('[data-slot="answer-run-result"]')
          ?.getAttribute("data-status"),
        label: document
          .querySelector('[data-slot="answer-run-result"]')
          ?.textContent?.trim(),
      }));

      record(
        "the run is handed the test file, not the solution",
        run.sent?.entry === "tests/test_solution.py" &&
          run.sent?.language === "python" &&
          run.sent?.files?.length === 2,
        `entry=${run.sent?.entry} language=${run.sent?.language} files=${run.sent?.files?.length}`
      );
      record(
        "a passing run says so in the panel",
        run.status === "passed" && /2 passed/.test(run.label ?? ""),
        `status=${run.status} label=${JSON.stringify(run.label)}`
      );

      await shot(page, "answer-run-passed.png");
      await context.close();
    }

    // A failing run has to open its own output: it is the reason the button exists.
    {
      const { context, page } = await answerTurn(browser, CASES.runnable, {
        exit_code: 1,
        stderr:
          'Traceback (most recent call last):\n  File "tests/test_solution.py", line 2\nAssertionError: add(2, 2) returned 5',
        duration_ms: 28,
      });

      await page.locator('[data-slot="answer-run-button"]').click();
      await page.waitForSelector('[data-slot="answer-run-result"]', { timeout: 10_000 });

      const failure = await page.evaluate(() => ({
        status: document
          .querySelector('[data-slot="answer-run-result"]')
          ?.getAttribute("data-status"),
        detail: document
          .querySelector('[data-slot="answer-run-detail"]')
          ?.textContent?.trim(),
      }));

      record(
        "a failing run shows the assertion without another click",
        failure.status === "failed" &&
          /add\(2, 2\) returned 5/.test(failure.detail ?? ""),
        `status=${failure.status} detail=${JSON.stringify(failure.detail)}`
      );

      await shot(page, "answer-run-failed.png");
      await context.close();
    }

    // Long: the panel caps at 488px, so anything taller has to scroll. It did not:
    // the Radix viewport was `height: 100%` inside a Root with only a max-height, so
    // it grew to its content, clientHeight equalled scrollHeight, and the wheel, the
    // scrollbar and the auto-scroll-to-bottom were all no-ops on the part of the
    // answer below the fold.
    {
      const { context, page } = await answerTurn(browser, CASES.long);
      const panel = await readPanel(page);

      record(
        "an answer taller than the panel is scrollable",
        panel.viewportClientH !== null &&
          panel.viewportScrollH > panel.viewportClientH + 100,
        `viewport ${panel.viewportClientH}px over ${panel.viewportScrollH}px of content`
      );

      await page.mouse.move(300, 400);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      const scrolled = await page.evaluate(
        () =>
          document.querySelector(
            '[data-radix-popper-content-wrapper] [data-slot="scroll-area-viewport"]'
          )?.scrollTop ?? 0
      );
      record(
        "the wheel reaches the text below the fold",
        scrolled > 0,
        `scrollTop ${scrolled} after a 600px wheel`
      );

      // Every DOM mutation during a stream used to trigger a native resize: 913 for
      // one answer, and a 600px flash before the panel had been measured.
      const heights = panel.resizeHeights;
      record(
        "one answer does not thrash the native window",
        heights.length <= 40,
        `${heights.length} set_window_height calls`
      );

      // The panel used to open at the 600px fallback and then collapse to its real
      // height a frame later, a 408px snap on every answer. Growing as the answer
      // streams is correct; a large step back down is the bug.
      const worstCollapse = heights.reduce(
        (worst, height, index) =>
          index === 0 ? worst : Math.max(worst, heights[index - 1] - height),
        0
      );
      record(
        "the window never snaps back down after opening",
        worstCollapse <= 64,
        `largest downward step ${worstCollapse}px across ${JSON.stringify(heights)}`
      );

      await shot(page, "answer-long.png");
      await context.close();
    }

    // Speak: the sentence is the payload and the follow-ups stay folded, because reading a
    // list out loud is exactly what the profile exists to prevent.
    {
      const { context, page } = await answerTurn(browser, CASES.speak);
      const panel = await readPanel(page);
      await shot(page, "answer-speak.png");

      record(
        "a spoken answer leads with the sentence, folded",
        panel.shape === "speak" &&
          /hash map/.test(panel.headline ?? "") &&
          panel.hasToggle &&
          !panel.bodyShown,
        `shape=${panel.shape} toggle=${panel.hasToggle} bodyShown=${panel.bodyShown}`
      );
      record(
        "a spoken answer is set large enough to read at a glance",
        (panel.headlineFontPx ?? 0) >= 17,
        `${panel.headlineFontPx}px`
      );
      record(
        "a spoken answer offers nothing to run",
        !panel.text.includes("Run tests"),
        panel.text.slice(0, 80).replace(/\n/g, " ")
      );

      await context.close();
    }

    // Diagram: the graph has to reach the panel as a graph, not as a fenced block of
    // mermaid source the reader has to imagine.
    {
      const { context, page } = await answerTurn(browser, CASES.diagram);
      await page
        .waitForSelector('[data-hud-response] svg, [data-hud-response] pre', {
          timeout: 20_000,
        })
        .catch(() => {});
      const panel = await readPanel(page);
      await shot(page, "answer-diagram.png");

      record(
        "a design answer leads with its thesis",
        panel.shape === "diagram" && /Fan out on write/.test(panel.headline ?? ""),
        `shape=${panel.shape} headline=${JSON.stringify(panel.headline)}`
      );
      record(
        "the design panel fits the HUD width",
        panel.overflowPx === 0,
        `${panel.overflowPx}px of horizontal overflow`
      );

      await context.close();
    }

    // Plain: an ordinary chat turn carries no contract and must be untouched.
    {
      const { context, page } = await answerTurn(browser, CASES.plain);
      const panel = await readPanel(page);
      await shot(page, "answer-plain.png");

      record(
        "an ordinary answer still renders as plain markdown",
        !panel.hasCard && /drops the last row/.test(panel.text),
        `card=${panel.hasCard} text=${panel.text.slice(0, 80).replace(/\n/g, " ")}`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed. ` +
      `Screenshots in ${OUT}`
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
