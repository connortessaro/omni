// Measures time to first token on the real HUD path, and splits it into the
// parts Omni controls and the part it does not.
//
// probe.mjs answers "is the layout right at rest". session.mjs answers "does a
// real conversation work", but it bills a real provider, so it cannot gate
// anything on a branch. This answers "how long until the user sees a character,
// and which of that is ours" against a scripted stream: the mock emits canned
// chunks on a fixed schedule (dev-harness/tauri-mock.js, __HARNESS_STREAM__), so
// provider time is a known constant and everything else is the app.
//
// Three segments, all measured in-page with performance.now():
//
//   submit  -> request      request assembly: template fill, base64 inlining, IPC
//   request -> first chunk  the scripted delay, a constant, not Omni's cost
//   chunk   -> first paint  parse, React state, markdown render
//
// TTFT is submit -> first paint. The budget is asserted on assembly + render
// only, because that is the part a regression can appear in.
//
// Two arms, so the image payload is attributed rather than guessed: the same
// prompt with no attachment and with a 688KB PNG.
//
// WebKit on purpose, same as the other probes: the app ships inside WKWebView.
//
// Usage: npm run dev:harness   (in another shell)
//        npm run ttft:probe

import { webkit } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";

const HUD_WIDTH = 600;
const HUD_RESTING_HEIGHT = 54;

/** A real capture-sized PNG, so the base64 arm carries a realistic payload. */
const IMAGE_FIXTURE = join(
  REPO_ROOT,
  "evals/fixtures/vision/vscode-web-adapters-2x.png"
);

/**
 * The scripted provider. The first-chunk delay stands in for a round trip and is
 * subtracted back out, so its exact value only needs to be long enough that the
 * app is genuinely waiting rather than racing its own startup.
 */
const FIRST_CHUNK_DELAY_MS = 300;

/**
 * Roughly a real token cadence. This started at 2ms, which is a 500-chunk-per-
 * second firehose no provider produces, and it made the render segment swing
 * between 193ms and 740ms across identical runs: the first paint was competing
 * for the main thread with the several hundred React updates queued behind it.
 * Measuring TTFT against a synthetic flood measures the flood.
 */
const CHUNK_INTERVAL_MS = 25;

/**
 * Budgets on the app's own share of TTFT, not on total. Set from measured
 * medians with room to spare: a real regression here is a rewrite of the
 * assembly path or a render that waits for the whole answer, both of which move
 * these by an order of magnitude, not by a few milliseconds.
 */
const BUDGET_MS = {
  // Measured medians on an M-series laptop: 3ms, 7ms, 25ms. The budgets are an
  // order of magnitude above that, which is deliberate. They are not there to
  // detect a few milliseconds of drift on a noisy CI box; they are there to
  // catch the regressions that actually matter and that are all 10x moves:
  // assembly that re-encodes the image per template variable, or a render that
  // waits for the whole answer instead of the first chunk (~700ms on this
  // fixture).
  assemblyNoImage: 50,
  assemblyWithImage: 150,
  render: 150,
};

/** Runs per arm; the median is what gets asserted. */
const RUNS = Number(process.env.TTFT_RUNS ?? 5);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const round = (n) => Math.round(n * 10) / 10;

/**
 * A provider selection and an answer the stream can deliver. The key is a
 * placeholder: the mock never sends the request anywhere, and seeding a real one
 * would put a credential in a probe.
 */
const seedState = (chunks) => ({
  provider: JSON.stringify({
    provider: "gemini",
    variables: { api_key: "harness-placeholder", model: "gemini-2.5-flash" },
  }),
  chunks,
});

/** OpenAI-compatible SSE, which is what the gemini provider streams. */
const sseChunks = (text) =>
  text
    .split(" ")
    .map(
      (word, index) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content: index === 0 ? word : ` ${word}` } }],
        })}\n\n`
    );

const ANSWER =
  "The parser drops the last row because the loop stops at length minus one, " +
  "so the final record is read but never appended to the output buffer.";

/**
 * Installed before app code. Seeds the provider so a turn can actually fire,
 * arms the scripted stream, and watches for the first painted character.
 *
 * First paint is observed rather than polled: a 50ms poll would put a 50ms
 * error bar on the smallest of the three segments.
 */
const initScript = ({ provider, chunks, firstChunkDelayMs, chunkIntervalMs }) => {
  localStorage.setItem("curl_selected_ai_provider", provider);
  window.__HARNESS_STREAM__ = { firstChunkDelayMs, chunkIntervalMs, chunks };
  window.__TTFT__ = {};

  const seeFirstPaint = () => {
    if (window.__TTFT__.firstPaintAt !== undefined) return;
    const node = document.querySelector("[data-hud-response]");
    if (node && node.innerText.trim().length > 0) {
      window.__TTFT__.firstPaintAt = performance.now();
    }
  };

  // Observes `document`, not `document.documentElement`: an init script runs at
  // document start, where documentElement is still null and observe() throws.
  new MutationObserver(seeFirstPaint).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
};

/** One turn, from an empty prompt to the first painted character. */
const runTurn = async (page, { withImage }) => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 15_000 });

  if (withImage) {
    await page.setInputFiles('input[type="file"]', IMAGE_FIXTURE);
    // There is nothing in the DOM to wait on. Files.tsx renders the thumbnail
    // inside a popover that stays closed, so no <img> and no data-slot ever
    // appears; waiting for one burned 30s per run. Reading the file to base64 is
    // async but fast (a few ms for 688KB against a 106ms setInputFiles), so a
    // short settle covers it, and the image count in the request body is the
    // real gate: if the encode had not finished, that assertion fails loudly
    // rather than the measurement quietly running without an image.
    await page.waitForTimeout(400);
  }

  await page.locator("textarea").click();
  await page.locator("textarea").fill("why does the parser drop the last row?");

  await page.evaluate(() => {
    window.__TTFT__.submitAt = performance.now();
  });
  await page.keyboard.press("Enter");

  // The response panel's scroll region collapses to zero height at the resting
  // window size, so WebKit reports no text inside it until the viewport grows.
  // The native window really does grow; the probe has to mirror that.
  await page.setViewportSize({ width: HUD_WIDTH, height: 600 });

  try {
    await page.waitForFunction(
      () => window.__TTFT__?.firstPaintAt !== undefined,
      { timeout: 20_000 }
    );
  } catch (error) {
    // A bare timeout here says nothing about which half failed, and the two
    // halves have completely different causes: no request means the turn never
    // fired, a request with no paint means the stream or the render broke.
    const state = await page.evaluate(() => ({
      marks: window.__TTFT__,
      requests: (window.__HARNESS__?.callsFor?.("provider_request") ?? []).length,
      responseText:
        document.querySelector("[data-hud-response]")?.innerText?.slice(0, 200) ??
        null,
    }));
    throw new Error(
      `No first paint within 20s. ${JSON.stringify(state)}\n${error.message}`
    );
  }

  // The stream is still running at first paint, which is the point, so the last
  // chunk has not been marked yet. Reading the marks before it lands is what
  // made paintAfterStreamEnd NaN.
  await page.waitForFunction(() => window.__TTFT__?.lastChunkAt !== undefined, {
    timeout: 30_000,
  });

  const marks = await page.evaluate(() => window.__TTFT__);
  await page.setViewportSize({
    width: HUD_WIDTH,
    height: HUD_RESTING_HEIGHT,
  });

  return {
    assembly: marks.requestAt - marks.submitAt,
    provider: marks.firstChunkAt - marks.requestAt,
    render: marks.firstPaintAt - marks.firstChunkAt,
    ttft: marks.firstPaintAt - marks.submitAt,
    // Negative means the first character painted before the stream ended, which
    // is what streaming is supposed to look like.
    paintAfterStreamEnd: marks.firstPaintAt - marks.lastChunkAt,
    streamDuration: marks.lastChunkAt - marks.firstChunkAt,
    bodyChars: marks.bodyChars,
    imageCount: marks.imageCount,
  };
};

const arm = async (page, label, options) => {
  // Discarded. On a cold vite the first turn pays for on-demand module
  // compilation, which showed up as a 952ms render and is not the app's cost.
  await runTurn(page, options);

  const runs = [];
  for (let i = 0; i < RUNS; i += 1) runs.push(await runTurn(page, options));

  const of = (key) => median(runs.map((r) => r[key]));
  const summary = {
    label,
    runs,
    assembly: of("assembly"),
    provider: of("provider"),
    render: of("render"),
    ttft: of("ttft"),
    paintAfterStreamEnd: of("paintAfterStreamEnd"),
    streamDuration: of("streamDuration"),
    bodyChars: runs[0].bodyChars,
    imageCount: runs[0].imageCount,
  };

  console.log(
    `\n${label}  (${RUNS} runs, medians)\n` +
      `  body            ${Math.round(summary.bodyChars / 1024)}KB, ${summary.imageCount} image(s)\n` +
      `  assembly        ${round(summary.assembly)}ms   submit -> request\n` +
      `  provider        ${round(summary.provider)}ms   scripted, not ours\n` +
      `  render          ${round(summary.render)}ms   first chunk -> first paint\n` +
      `  TTFT            ${round(summary.ttft)}ms   submit -> first paint\n` +
      `  ours            ${round(summary.assembly + summary.render)}ms   assembly + render\n` +
      `  stream lasted   ${round(summary.streamDuration)}ms   first chunk -> last chunk\n` +
      `  paint vs end    ${round(summary.paintAfterStreamEnd)}ms   negative means it streamed\n` +
      `  (each row is its own median, so the segments need not add to TTFT here;\n` +
      `   the identity is checked per run)\n`
  );

  return summary;
};

const main = async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({
    viewport: { width: HUD_WIDTH, height: HUD_RESTING_HEIGHT },
  });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.addInitScript(initScript, {
    ...seedState(sseChunks(ANSWER)),
    firstChunkDelayMs: FIRST_CHUNK_DELAY_MS,
    chunkIntervalMs: CHUNK_INTERVAL_MS,
  });

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 15_000 });

  const plain = await arm(page, "no attachment", { withImage: false });
  const image = await arm(page, "688KB PNG attached", { withImage: true });

  record(
    "TTFT is measured separately from total response time",
    plain.ttft > 0 && plain.provider > 0 && plain.ttft > plain.provider,
    `TTFT ${round(plain.ttft)}ms, of which ${round(plain.provider)}ms is the scripted round trip`
  );

  record(
    "the scripted round trip is honoured, so provider time is a known constant",
    Math.abs(plain.provider - FIRST_CHUNK_DELAY_MS) < 100,
    `${round(plain.provider)}ms against a configured ${FIRST_CHUNK_DELAY_MS}ms`
  );

  record(
    "request assembly without an image stays within budget",
    plain.assembly < BUDGET_MS.assemblyNoImage,
    `${round(plain.assembly)}ms < ${BUDGET_MS.assemblyNoImage}ms`
  );

  record(
    "request assembly with a 688KB image stays within budget",
    image.assembly < BUDGET_MS.assemblyWithImage,
    `${round(image.assembly)}ms < ${BUDGET_MS.assemblyWithImage}ms`
  );

  record(
    "the image reaches the request body",
    image.imageCount >= 1 && image.bodyChars > plain.bodyChars,
    `${image.imageCount} image(s), body ${Math.round(image.bodyChars / 1024)}KB against ${Math.round(plain.bodyChars / 1024)}KB without`
  );

  record(
    "first paint follows the first chunk within budget",
    plain.render < BUDGET_MS.render && image.render < BUDGET_MS.render,
    `${round(plain.render)}ms plain, ${round(image.render)}ms with image, budget ${BUDGET_MS.render}ms`
  );

  record(
    "the first character paints before the stream finishes",
    plain.paintAfterStreamEnd < 0,
    `first paint ${round(Math.abs(plain.paintAfterStreamEnd))}ms ` +
      `${plain.paintAfterStreamEnd < 0 ? "before" : "AFTER"} the last chunk, ` +
      `over a ${round(plain.streamDuration)}ms stream`
  );

  // Checked per run, not against the medians. Each median is taken over its own
  // segment independently, so medians from different runs do not have to add up:
  // on a fast machine they agreed within 2ms and on a shared runner they did
  // not, which failed this assertion for no real reason. Per run the identity is
  // exact, and what it actually guards is a mark going missing, which is how the
  // NaN in paintAfterStreamEnd showed up.
  const allRuns = [...plain.runs, ...image.runs];
  const worstResidual = Math.max(
    ...allRuns.map((r) =>
      Math.abs(r.ttft - (r.assembly + r.provider + r.render))
    )
  );
  const marksSane = allRuns.every(
    (r) =>
      [r.assembly, r.provider, r.render, r.ttft, r.streamDuration].every(
        (v) => Number.isFinite(v)
      ) &&
      r.assembly >= 0 &&
      r.provider > 0 &&
      r.render >= 0
  );

  record(
    "every mark is present and the segments account for TTFT in each run",
    marksSane && worstResidual < 0.001,
    marksSane
      ? `worst residual ${worstResidual}ms across ${allRuns.length} runs`
      : "a segment was missing or negative, so a performance mark never landed"
  );

  record(
    "no console errors during a measured turn",
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? "none" : consoleErrors.slice(0, 3).join(" | ")
  );

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      `\n\nimage payload costs ${round(image.assembly - plain.assembly)}ms of assembly` +
      ` and ${round(image.ttft - plain.ttft)}ms of TTFT`
  );

  if (failed.length > 0) {
    console.error(`\n${failed.length} assertion(s) failed.`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
