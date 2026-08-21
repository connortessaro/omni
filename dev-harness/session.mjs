// Runs a scripted conversation through the real HUD in a real browser, against a
// real model, and records what each turn actually cost.
//
// probe.mjs answers "is the layout right at rest". This answers "does the thing
// work when you use it in anger": several turns, attachments, pasted code,
// screenshots, and the byte/latency accounting the app itself never reports.
//
// WebKit on purpose, same as probe.mjs: the app ships inside WKWebView.
//
// Usage: npm run dev:live   (in another shell)
//        node dev-harness/session.mjs --out repo-issue \
//          --turn "why does the parser drop the last row?" \
//          --attach fixtures/parser.ts --turn "which file would you change?"
//
// Turn actions run in the order given, so --attach and --paste before a --turn
// apply to that turn.

import { webkit } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";
const PROXY = process.env.HARNESS_PROXY ?? "http://127.0.0.1:1422";

const HUD_WIDTH = 600;
const HUD_RESTING_HEIGHT = 54;

/** A turn is done when loading stops; this is the ceiling on waiting for that. */
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 120_000);

const parseArgs = (argv) => {
  const steps = [];
  let out = "session";
  let url = APP_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--out") { out = value; i++; }
    else if (arg === "--url") { url = value; i++; }
    else if (arg === "--turn") { steps.push({ kind: "turn", text: value }); i++; }
    else if (arg === "--attach") { steps.push({ kind: "attach", path: resolve(value) }); i++; }
    else if (arg === "--paste") { steps.push({ kind: "paste", path: resolve(value) }); i++; }
    else if (arg === "--screenshot") { steps.push({ kind: "screenshot" }); }
    else if (arg === "--engage") { steps.push({ kind: "engage" }); }
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!steps.some((step) => step.kind === "turn")) {
    console.error("At least one --turn is required.");
    process.exit(2);
  }
  return { steps, out, url };
};

const { steps, out, url } = parseArgs(process.argv.slice(2));
const OUT_DIR = join(HERE, "out", out);
mkdirSync(OUT_DIR, { recursive: true });

const proxyStats = async (method = "GET") => {
  const response = await fetch(`${PROXY}/stats`, { method });
  if (!response.ok) throw new Error(`Proxy /stats returned ${response.status}`);
  return (await response.json()).requests;
};

/** Mirrors the native window following set_window_height, so shots are truthful. */
const syncViewport = async (page) => {
  const requested = await page.evaluate(
    () => window.__HARNESS__?.lastWindowHeight() ?? null
  );
  const height = Math.max(requested ?? HUD_RESTING_HEIGHT, HUD_RESTING_HEIGHT);
  await page.setViewportSize({ width: HUD_WIDTH, height });
  return { requested, height };
};

const isLoading = (page) =>
  page.evaluate(() => document.querySelector("[data-hud-loading]") !== null);

const responseText = (page) =>
  page.evaluate(
    () => document.querySelector("[data-hud-response]")?.innerText ?? ""
  );

const errorText = (page) =>
  page.evaluate(() => {
    const node = Array.from(document.querySelectorAll("#popover-content strong")).find(
      (el) => el.textContent?.trim() === "Error:"
    );
    return node?.parentElement?.innerText ?? "";
  });

const historyNotice = (page) =>
  page.evaluate(
    () => document.querySelector('[data-slot="history-notice"]')?.innerText ?? ""
  );

/**
 * What actually went out, read off the mock's own call log.
 *
 * The context chips claim the attached files are part of the conversation. Whether
 * they are is a property of the request body, not of the UI, so it gets read from
 * the request body. `renderBlocksAsText` prefixes them with "Attached context (",
 * which makes their presence a single check.
 */
const sentBodies = (page) =>
  page.evaluate(() =>
    (window.__HARNESS__?.callsFor("provider_request") ?? []).map((call) => {
      const body = call.args?.request?.body ?? "";
      return {
        chars: body.length,
        hasAttachedContext: body.includes("Attached context ("),
        images: (body.match(/data:image\/png;base64,/g) ?? []).length,
      };
    })
  );

const chipLabels = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="context-chip"]')).map(
      (chip) => chip.innerText.replace(/\s+/g, " ").trim()
    )
  );

/**
 * Waits for the turn to finish. Loading may not have started yet when this is
 * called, so it waits for the indicator to appear first, then for it to go.
 *
 * Also records when the first character of the answer rendered. Time to first text
 * against total time is the difference between reading an answer as it arrives and
 * staring at a spinner until it is finished, which is the whole experience of using
 * this under time pressure.
 */
const waitForTurn = async (page, startedAt) => {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let firstTextMs = null;

  // The response panel's scroll region is `h-[calc(100vh-7rem)]`, so at the 54px
  // resting height it computes to zero and WebKit reports no text inside it. The
  // real app avoids that because the native window really does grow; the driver has
  // to mirror that as it happens, not once the turn is over.
  const tick = async () => {
    await syncViewport(page);
    if (firstTextMs === null && (await responseText(page)).length > 0) {
      firstTextMs = Date.now() - startedAt;
    }
  };

  while (Date.now() < deadline) {
    if (await isLoading(page)) break;
    await tick();
    if ((await errorText(page)) !== "") {
      return { finished: true, viaError: true, firstTextMs };
    }
    await page.waitForTimeout(50);
  }

  while (Date.now() < deadline) {
    await tick();
    if (!(await isLoading(page))) {
      // Let the last streamed chunk render before reading the text back.
      await page.waitForTimeout(300);
      await tick();
      return { finished: true, viaError: false, firstTextMs };
    }
    await page.waitForTimeout(50);
  }
  return { finished: false, viaError: false, firstTextMs };
};

/** Pastes text the way a user would, so the app's own paste handler runs. */
const pasteText = async (page, text) => {
  await page.locator("textarea").click();
  await page.evaluate((content) => {
    const textarea = document.querySelector("textarea");
    if (!textarea) throw new Error("No prompt textarea to paste into");
    const data = new DataTransfer();
    data.setData("text/plain", content);
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
    );
  }, text);
};

const main = async () => {
  await proxyStats("DELETE");

  const browser = await webkit.launch();
  const page = await browser.newPage({
    viewport: { width: HUD_WIDTH, height: HUD_RESTING_HEIGHT },
  });

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 15_000 });

  const log = [];
  let turnIndex = 0;
  let statsSeen = 0;
  let bodiesSeen = 0;

  for (const step of steps) {
    if (step.kind === "attach") {
      await page.setInputFiles('input[type="file"]', step.path);
      console.log(`attach  ${basename(step.path)}`);
      continue;
    }
    if (step.kind === "paste") {
      await pasteText(page, readFileSync(step.path, "utf8"));
      console.log(`paste   ${basename(step.path)}`);
      continue;
    }
    if (step.kind === "screenshot") {
      // useTitles moves `title` to `data-original-title`, so match either.
      const button = page
        .locator(
          'button[data-original-title^="Screenshot mode"], button[title^="Screenshot mode"]'
        )
        .first();
      const before = await page.evaluate(
        () => window.__HARNESS__?.callsFor("capture_to_base64").length ?? 0
      );
      await button.click();
      await page.waitForFunction(
        (count) =>
          (window.__HARNESS__?.callsFor("capture_to_base64").length ?? 0) > count,
        before,
        { timeout: 10_000 }
      );
      console.log("screenshot captured (fixture PNG via proxy)");
      continue;
    }
    if (step.kind === "engage") {
      await page.locator('button[role="switch"]').first().click();
      console.log("keepEngaged toggled");
      continue;
    }

    turnIndex++;
    const chipsBefore = await chipLabels(page);

    await page.locator("textarea").click();
    await page.locator("textarea").fill(step.text);
    const startedAt = Date.now();
    await page.keyboard.press("Enter");

    const { finished, viaError, firstTextMs } = await waitForTurn(page, startedAt);
    const wallMs = Date.now() - startedAt;

    const window = await syncViewport(page);
    await page.screenshot({
      path: join(OUT_DIR, `turn-${String(turnIndex).padStart(2, "0")}.png`),
      fullPage: false,
    });

    const requests = await proxyStats();
    const forThisTurn = requests.slice(statsSeen);
    statsSeen = requests.length;

    const bodies = await sentBodies(page);
    const bodiesThisTurn = bodies.slice(bodiesSeen);
    bodiesSeen = bodies.length;

    const entry = {
      turn: turnIndex,
      prompt: step.text,
      chipsBefore,
      chipsAfter: await chipLabels(page),
      finished,
      viaError,
      wallMs,
      firstTextMs,
      requests: forThisTurn,
      sentBodies: bodiesThisTurn,
      requestBytes: forThisTurn.reduce((sum, r) => sum + r.requestBytes, 0),
      windowHeightRequested: window.requested,
      historyNotice: await historyNotice(page),
      error: await errorText(page),
      response: await responseText(page),
    };
    log.push(entry);

    console.log(
      `turn ${turnIndex}  ${finished ? "ok" : "TIMEOUT"}  ` +
        `${wallMs}ms (first text ${firstTextMs ?? "never"}ms)  ` +
        `sent=${(entry.requestBytes / 1024).toFixed(1)}KB  ` +
        `calls=${forThisTurn.length}  ` +
        `context=${bodiesThisTurn.map((b) => (b.hasAttachedContext ? "yes" : "no")).join(",") || "-"}  ` +
        `images=${bodiesThisTurn.map((b) => b.images).join(",") || "-"}  ` +
        `height=${window.requested}  ` +
        `chars=${entry.response.length}${entry.error ? `  ERROR: ${entry.error}` : ""}`
    );
    if (entry.historyNotice) console.log(`        notice: ${entry.historyNotice}`);
  }

  const report = { url, steps, consoleErrors, turns: log };
  writeFileSync(join(OUT_DIR, "session.json"), JSON.stringify(report, null, 2));

  const transcript = log
    .map(
      (turn) =>
        `### Turn ${turn.turn}\n\n**Sent:** ${turn.prompt}\n\n` +
        `${turn.error ? `**Error:** ${turn.error}\n\n` : ""}` +
        `${turn.response}\n`
    )
    .join("\n---\n\n");
  writeFileSync(join(OUT_DIR, "transcript.md"), transcript);

  if (consoleErrors.length > 0) {
    console.log(`\n${consoleErrors.length} console error(s):`);
    for (const message of consoleErrors.slice(0, 10)) console.log(`  ${message}`);
  }
  console.log(`\nWrote ${OUT_DIR}/session.json and transcript.md`);

  await browser.close();
  process.exit(log.every((turn) => turn.finished && !turn.error) ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
