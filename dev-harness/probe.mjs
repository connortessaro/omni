// Renders the real HUD in Playwright's WebKit and measures it.
//
// WebKit on purpose: the app ships inside WKWebView, and Chromium supports CSS
// that WebKit does not (`field-sizing: content`), so a Chromium probe would pass
// on layout the real app gets wrong.
//
// Usage: npm run dev   (in another shell)
//        npm run hud:probe
import { webkit } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";

/** The HUD window size configured in tauri.conf.json. */
const HUD_WIDTH = 600;
const HUD_RESTING_HEIGHT = 54;
const PROMPT_PLACEHOLDER = "Ask anything or type /";

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

/** Mirrors the native window following set_window_height, so shots are truthful. */
const captureAt = async (page, requestedHeight, file) => {
  await page.setViewportSize({
    width: HUD_WIDTH,
    height: Math.max(requestedHeight ?? HUD_RESTING_HEIGHT, HUD_RESTING_HEIGHT),
  });
  await page.screenshot({ path: join(OUT, file) });
};

const measure = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-slot="card"]');
    const prompt = document.querySelector("textarea");
    const round = (n) => Math.round(n * 100) / 100;
    return {
      cardHeight: card ? round(card.getBoundingClientRect().height) : null,
      promptHeight: prompt ? round(prompt.getBoundingClientRect().height) : null,
      promptScrollHeight: prompt ? prompt.scrollHeight : null,
      promptClientHeight: prompt ? prompt.clientHeight : null,
      promptInlineHeight: prompt ? prompt.style.height || "(none)" : null,
      promptComputedMinHeight: prompt
        ? getComputedStyle(prompt).minHeight
        : null,
      promptLineHeight: prompt ? getComputedStyle(prompt).lineHeight : null,
      chips: document.querySelectorAll('[data-slot="context-chip"]').length,
      overlayBottomOverflow: (() => {
        const card = document.querySelector('[data-slot="card"]');
        if (!card) return null;
        const cardRect = card.getBoundingClientRect();
        let lowest = cardRect.bottom;
        card.querySelectorAll("[data-hud-overlay]").forEach((overlay) => {
          const r = overlay.getBoundingClientRect();
          if (r.height > 0) lowest = Math.max(lowest, r.bottom);
        });
        return Math.round(lowest - cardRect.top);
      })(),
      requestedWindowHeight: window.__HARNESS__?.lastWindowHeight() ?? null,
      overflowingChildren: card
        ? Array.from(card.children)
            .map((child) => {
              const c = card.getBoundingClientRect();
              const r = child.getBoundingClientRect();
              return r.height > 0 && (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5)
                ? `${child.tagName.toLowerCase()}.${String(child.className).split(" ")[0]}`
                : null;
            })
            .filter(Boolean)
        : [],
    };
  });

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await webkit.launch();
  const context = await browser.newContext({
    viewport: { width: HUD_WIDTH, height: HUD_RESTING_HEIGHT },
    deviceScaleFactor: 2,
  });
  await context.addInitScript({
    content: readFileSync(join(HERE, "tauri-mock.js"), "utf8"),
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const prompt = page.getByPlaceholder(PROMPT_PLACEHOLDER);
  await prompt.waitFor({ state: "visible", timeout: 15000 });

  // 1. resting geometry
  const resting = await measure(page);
  await page.screenshot({ path: join(OUT, "1-resting.png") });
  record(
    "resting HUD is one row tall",
    resting.cardHeight === HUD_RESTING_HEIGHT,
    `card=${resting.cardHeight}px (want ${HUD_RESTING_HEIGHT}) prompt=${resting.promptHeight}px ` +
      `min-height=${resting.promptComputedMinHeight} inline-height=${resting.promptInlineHeight}`
  );

  record(
    "placeholder fits without wrapping",
    resting.promptScrollHeight <= resting.promptClientHeight,
    `empty box scrollHeight=${resting.promptScrollHeight} clientHeight=${resting.promptClientHeight}`
  );

  // 2. growth on a wrapped second line
  await prompt.click();
  await prompt.pressSequentially("first line of a real problem statement");
  await prompt.press("Shift+Enter");
  await prompt.pressSequentially("second line that should make the box taller");
  const grown = await measure(page);
  await captureAt(page, grown.requestedWindowHeight, "2-two-lines.png");
  record(
    "prompt box grows for a second line",
    grown.promptHeight > resting.promptHeight &&
      grown.cardHeight > resting.cardHeight,
    `prompt ${resting.promptHeight} -> ${grown.promptHeight}px, card ${resting.cardHeight} -> ${grown.cardHeight}px, ` +
      `scrollHeight=${grown.promptScrollHeight} clientHeight=${grown.promptClientHeight}`
  );
  record(
    "grown HUD asks the window to resize",
    grown.requestedWindowHeight !== null &&
      grown.requestedWindowHeight > HUD_RESTING_HEIGHT,
    `set_window_height last requested ${grown.requestedWindowHeight}px`
  );

  // 3. shrink back
  await page.setViewportSize({ width: HUD_WIDTH, height: HUD_RESTING_HEIGHT });
  await prompt.fill("");
  const shrunk = await measure(page);
  record(
    "prompt box shrinks back to one row",
    shrunk.cardHeight === HUD_RESTING_HEIGHT,
    `card=${shrunk.cardHeight}px prompt=${shrunk.promptHeight}px`
  );

  // 4. a large paste becomes a context chip, not prompt text
  const pasted = await page.evaluate(() => {
    const target = document.querySelector("textarea");
    if (!target) return { ok: false, reason: "no textarea" };
    const text = Array.from(
      { length: 40 },
      (_, i) => `const line${i} = compute(${i}); // pasted source line ${i}`
    ).join("\n");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [],
        getData: (type) => (type === "text/plain" ? text : ""),
      },
    });
    target.dispatchEvent(event);
    return { ok: true, chars: text.length };
  });

  await page.waitForTimeout(300);
  const chipped = await measure(page);
  await captureAt(page, chipped.requestedWindowHeight, "3-context-chip.png");
  record(
    "large paste becomes a context chip",
    chipped.chips === 1,
    `pasted ${pasted.chars} chars -> ${chipped.chips} chip(s), prompt text left empty=${
      (await prompt.inputValue()) === ""
    }`
  );
  record(
    "nothing overflows the HUD card",
    chipped.overflowingChildren.length === 0,
    chipped.overflowingChildren.length
      ? `clipped: ${chipped.overflowingChildren.join(", ")}`
      : "all children within card bounds"
  );
  record(
    "chip row makes the HUD taller",
    chipped.cardHeight > HUD_RESTING_HEIGHT,
    `card=${chipped.cardHeight}px, window asked for ${chipped.requestedWindowHeight}px`
  );

  // 5. an out-of-flow overlay must still fit the window the app requests
  await page.setViewportSize({ width: HUD_WIDTH, height: HUD_RESTING_HEIGHT });
  await prompt.fill("");
  await prompt.click();
  await prompt.pressSequentially("/co");
  // The menu slides in with a transform; wait it out so the visual box and the
  // layout box agree before comparing them.
  await page.waitForTimeout(600);
  const withMenu = await measure(page);
  await captureAt(page, withMenu.requestedWindowHeight, "4-slash-menu.png");
  record(
    "slash-command menu fits inside the requested window",
    withMenu.overlayBottomOverflow > HUD_RESTING_HEIGHT &&
      withMenu.requestedWindowHeight >= withMenu.overlayBottomOverflow,
    `menu reaches ${withMenu.overlayBottomOverflow}px below the card top, window asked for ${withMenu.requestedWindowHeight}px`
  );
  await prompt.fill("");

  record(
    "no console errors",
    consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 5).join(" | ") : "clean"
  );

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed. Screenshots in ${OUT}`
  );
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error("probe crashed:", error);
  process.exitCode = 1;
});
