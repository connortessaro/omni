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

/** Must match SLASH_MENU_ID in src/pages/app/components/completion/Input.tsx. */
const SLASH_MENU_ID = "slash-command-menu";

/** Seeded into localStorage so arrow-key recall has something to recall. */
const SEEDED_PROMPT_HISTORY = [
  "an earlier prompt that recall should reach",
  "an older prompt behind it",
];

/**
 * Headless WebKit refuses navigator.clipboard.readText without a user gesture, so
 * the clipboard-peek assertions run against this stub on a page of their own.
 */
const STUB_CLIPBOARD = "a clipboard payload the peek bar should offer once";

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

/**
 * The slash menu's keyboard state read off the accessibility tree rather than off
 * the styling, so the assertions hold even if the highlight is restyled.
 */
const readSlashMenu = (page) =>
  page.evaluate((menuId) => {
    const prompt = document.querySelector("textarea");
    const list = document.getElementById(menuId);
    const options = list
      ? Array.from(list.querySelectorAll('[role="option"]'))
      : [];
    return {
      open: Boolean(list),
      options: options.map((option) => option.id),
      selected: options
        .filter((option) => option.getAttribute("aria-selected") === "true")
        .map((option) => option.id),
      activeDescendant: prompt?.getAttribute("aria-activedescendant") ?? null,
      expanded: prompt?.getAttribute("aria-expanded") ?? null,
      controls: prompt?.getAttribute("aria-controls") ?? null,
    };
  }, SLASH_MENU_ID);

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

  // Pin the provider to "none" so submitting takes the "No AI provider selected"
  // path. This probe asserts layout and state behaviour and must not need a key or
  // a network call. Written rather than removed because seed-settings.js only fills
  // the key when it is absent, so a present-but-empty value survives under
  // `npm run dev:live` as well as under a plain `npm run dev`.
  await context.addInitScript(() => {
    try {
      localStorage.setItem(
        "curl_selected_ai_provider",
        JSON.stringify({ provider: "", variables: {} })
      );
    } catch {
      // A browser with storage disabled still exercises the layout assertions.
    }
  });

  await context.addInitScript((history) => {
    try {
      localStorage.setItem("omni_prompt_history", JSON.stringify(history));
    } catch {
      // Same as above: no storage just means the recall assertion is the loss.
    }
  }, SEEDED_PROMPT_HISTORY);

  const page = await context.newPage();
  const consoleErrors = [];
  // The HUD probes Ollama on localhost:11434 to offer local models. When nothing
  // is listening the component handles it, but the browser still logs a failed
  // resource load, so that one endpoint is not treated as a defect.
  const OPTIONAL_ENDPOINTS = ["11434"];
  // Named so the later single-purpose pages report faults into the same list.
  const watchForErrors = (target, label = "") => {
    const tag = label ? ` (${label})` : "";
    target.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location()?.url ?? "";
      if (OPTIONAL_ENDPOINTS.some((host) => url.includes(host))) return;
      consoleErrors.push(`${message.text()}${tag} ${url}`.trim());
    });
    target.on("pageerror", (error) =>
      consoleErrors.push(`pageerror${tag}: ${error.message}`)
    );
  };
  watchForErrors(page);

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

  // 1c. a fresh profile defaults to region capture, not the whole screen.
  //
  // A full-screen capture at 2560x1600 is transcribed to about 60% and then
  // stops, silently. Region capture is measured at 0-1.7% character error. The
  // default that decides which one a new user gets used to be set by a one-time
  // migration that never persisted, so the whole-screen path won on relaunch.
  const captureDefault = await page.evaluate(() => {
    const raw = localStorage.getItem("screenshot_config");
    const button = document.querySelector('[data-slot="hud-screenshot"]');
    return {
      raw,
      legacySentinel: localStorage.getItem("auto-configs-enabled"),
      // useTitles moves `title` to `data-original-title` so the OS tooltip never
      // draws over a stealth overlay, so match either. session.mjs does the same.
      title:
        button?.getAttribute("data-original-title") ??
        button?.getAttribute("title") ??
        null,
    };
  });
  record(
    "a fresh profile defaults to region capture",
    captureDefault.title !== null &&
      captureDefault.title.startsWith("Selection mode") &&
      captureDefault.legacySentinel === null,
    `title=${JSON.stringify(captureDefault.title)} ` +
      `screenshot_config=${captureDefault.raw ?? "(unset)"} ` +
      `auto-configs-enabled=${captureDefault.legacySentinel ?? "(absent)"}`
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

  // 5b. the arrow keys have to reach the menu. useCompletion's handleKeyPress
  // claims ArrowUp/ArrowDown for prompt-history recall, so ArrowDown over an open
  // menu used to wipe the typed `/` and paste in a whole previous submission.
  const menuAtRest = await readSlashMenu(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  const menuAfterArrow = await readSlashMenu(page);
  const promptAfterArrow = await prompt.inputValue();
  await captureAt(page, withMenu.requestedWindowHeight, "4b-slash-menu-active-row.png");
  record(
    "ArrowDown moves the slash-menu selection without touching the prompt",
    menuAtRest.selected.length === 1 &&
      menuAfterArrow.selected.length === 1 &&
      menuAfterArrow.selected[0] !== menuAtRest.selected[0] &&
      menuAfterArrow.activeDescendant === menuAfterArrow.selected[0] &&
      menuAfterArrow.controls === SLASH_MENU_ID &&
      promptAfterArrow === "/co",
    `selected ${menuAtRest.selected[0]} -> ${menuAfterArrow.selected[0]} ` +
      `(${menuAfterArrow.selected.length} row(s) aria-selected of ${menuAfterArrow.options.length}), ` +
      `aria-activedescendant=${menuAfterArrow.activeDescendant}, prompt still "${promptAfterArrow}"`
  );

  // 5c. Enter over an open menu accepts, it does not submit.
  const highlightedCommand = `/${String(menuAfterArrow.selected[0]).replace(
    "slash-command-",
    ""
  )}`;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const promptAfterAccept = await prompt.inputValue();
  const menuAfterAccept = await readSlashMenu(page);
  record(
    "Enter accepts the highlighted slash command",
    promptAfterAccept === `${highlightedCommand} ` && !menuAfterAccept.open,
    `prompt became "${promptAfterAccept}" (want "${highlightedCommand} "), menu still open=${menuAfterAccept.open}`
  );

  // 5d. Escape puts the menu away and leaves the typed text alone.
  await prompt.fill("");
  await prompt.click();
  await prompt.pressSequentially("/");
  await page.waitForTimeout(300);
  const menuOnSlash = await readSlashMenu(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const menuAfterEscape = await readSlashMenu(page);
  const promptAfterEscape = await prompt.inputValue();
  record(
    "Escape dismisses the slash menu and keeps the typed text",
    menuOnSlash.open &&
      menuOnSlash.selected.length === 1 &&
      !menuAfterEscape.open &&
      menuAfterEscape.expanded === "false" &&
      promptAfterEscape === "/",
    `menu open=${menuOnSlash.open} -> ${menuAfterEscape.open}, ` +
      `aria-expanded=${menuAfterEscape.expanded}, prompt still "${promptAfterEscape}"`
  );

  // 5e. an argument closes the menu. It used to match on the first token only, so
  // the menu sat over the answer area for as long as the argument was being typed.
  await prompt.fill("");
  await prompt.click();
  await prompt.pressSequentially("/fix hello");
  await page.waitForTimeout(300);
  const menuWithArgument = await readSlashMenu(page);
  record(
    "typing an argument closes the slash menu",
    !menuWithArgument.open &&
      menuWithArgument.expanded === "false" &&
      menuWithArgument.activeDescendant === null,
    `after "/fix hello": menu open=${menuWithArgument.open}, ` +
      `aria-expanded=${menuWithArgument.expanded}, aria-activedescendant=${menuWithArgument.activeDescendant}`
  );

  // 5f. Backspace on an empty prompt takes the last attachment. Without it a
  // paste chip has no keyboard route out, so clearing the prompt leaves a paste
  // icon sitting there and the delete reads as having done nothing.
  await prompt.fill("");
  const seededChip = await page.evaluate(() => {
    const target = document.querySelector("textarea");
    if (!target) return false;
    const text = Array.from(
      { length: 40 },
      (_, i) => `const seeded${i} = ${i}; // backspace seed line ${i}`
    ).join("\n");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [], getData: (type) => (type === "text/plain" ? text : "") },
    });
    target.dispatchEvent(event);
    return true;
  });
  await page.waitForTimeout(300);
  const chipsBeforeBackspace = (await measure(page)).chips;
  await prompt.click();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  const chipsAfterBackspace = (await measure(page)).chips;
  record(
    "Backspace on an empty prompt removes the last context chip",
    seededChip &&
      chipsBeforeBackspace > 0 &&
      chipsAfterBackspace === chipsBeforeBackspace - 1,
    `chips ${chipsBeforeBackspace} -> ${chipsAfterBackspace} after one Backspace on an empty prompt`
  );

  // 5g. the other half of 5b: with the menu closed the arrows must still belong to
  // prompt-history recall. Setting a controlled value moves the caret to the end,
  // and recall only fires from the ends, so the caret is placed explicitly.
  const setCaret = (where) =>
    page.evaluate((edge) => {
      const field = document.querySelector("textarea");
      if (!field) return;
      const at = edge === "end" ? field.value.length : 0;
      field.setSelectionRange(at, at);
    }, where);

  await prompt.fill("");
  await prompt.click();
  await setCaret("start");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  const recalledOldest = await prompt.inputValue();
  await setCaret("start");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  const recalledNewer = await prompt.inputValue();
  await setCaret("end");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const walkedBackDown = await prompt.inputValue();
  record(
    "prompt-history recall still owns the arrows when no menu is open",
    recalledOldest === SEEDED_PROMPT_HISTORY[0] &&
      recalledNewer === SEEDED_PROMPT_HISTORY[1] &&
      walkedBackDown === SEEDED_PROMPT_HISTORY[0],
    `ArrowUp "${recalledOldest}" then "${recalledNewer}", ArrowDown back to "${walkedBackDown}"`
  );

  await prompt.fill("");

  // 6. the model switcher popover renders in a portal outside the HUD card, so
  // the content-height observer cannot see it and the window must expand for it
  await page.setViewportSize({ width: HUD_WIDTH, height: HUD_RESTING_HEIGHT });
  // Not getByTitle: useTitles strips every title attribute in the HUD to keep
  // native tooltips from appearing over the overlay.
  const switcher = page.locator('[data-slot="model-switcher"]');
  await switcher.click();
  await page.waitForTimeout(700);
  const switcherState = await page.evaluate(() => ({
    popoverOpen: document.querySelectorAll("[data-radix-popper-content-wrapper]")
      .length,
    modelOptions: document.querySelectorAll('[data-slot="model-option"]').length,
    requestedWindowHeight: window.__HARNESS__?.lastWindowHeight() ?? null,
    sectionText:
      document.querySelector("[data-radix-popper-content-wrapper]")?.textContent
        ?.slice(0, 200) ?? "",
  }));
  await captureAt(page, switcherState.requestedWindowHeight, "5-model-switcher.png");
  record(
    "model switcher popover expands the window instead of being clipped",
    switcherState.popoverOpen > 0 &&
      (switcherState.requestedWindowHeight ?? 0) > HUD_RESTING_HEIGHT,
    `popovers open=${switcherState.popoverOpen}, window asked for ${switcherState.requestedWindowHeight}px, model options=${switcherState.modelOptions}`
  );
  record(
    "model section reports something rather than sitting blank",
    /model/i.test(switcherState.sectionText),
    `panel text: ${switcherState.sectionText.replace(/\s+/g, " ").slice(0, 120)}`
  );
  await page.keyboard.press("Escape");

  // 7. attached context has to outlive a turn.
  //
  // The chips are the user's only evidence that the model can still see the files
  // they attached. If a follow-up is sent without them, the model answers from
  // whatever it happens to know about the code instead, confidently and wrongly,
  // and the chips are still on screen while it does. This is the whole difference
  // between a working multi-turn debugging session and a misleading one.
  await page.setViewportSize({ width: HUD_WIDTH, height: HUD_RESTING_HEIGHT });
  await prompt.fill("");
  const attachContext = await page.evaluate(() => {
    const target = document.querySelector("textarea");
    if (!target) return { ok: false };
    const text = Array.from(
      { length: 40 },
      (_, i) => `export const marker${i} = ${i}; // attached source line ${i}`
    ).join("\n");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [], getData: (type) => (type === "text/plain" ? text : "") },
    });
    target.dispatchEvent(event);
    return { ok: true };
  });
  await page.waitForTimeout(300);
  const chipsAttached = (await measure(page)).chips;
  // Relative, not absolute: an earlier assertion leaves a chip behind on purpose.

  await prompt.click();
  await prompt.pressSequentially("first question about the attached file");
  await prompt.press("Enter");
  await page.waitForTimeout(600);
  const chipsAfterFirstTurn = (await measure(page)).chips;

  await prompt.click();
  await prompt.pressSequentially("follow-up question about the same file");
  await prompt.press("Enter");
  await page.waitForTimeout(600);
  const chipsAfterFollowUp = (await measure(page)).chips;

  await captureAt(page, HUD_RESTING_HEIGHT * 4, "6-context-across-turns.png");
  record(
    "attached context survives a follow-up turn",
    attachContext.ok &&
      chipsAttached > 0 &&
      chipsAfterFirstTurn === chipsAttached &&
      chipsAfterFollowUp === chipsAttached,
    `chips: ${chipsAttached} attached -> ${chipsAfterFirstTurn} after turn 1 -> ` +
      `${chipsAfterFollowUp} after the follow-up`
  );

  // 8. the answer panel is sized to the answer.
  //
  // It used to request a flat 600px the moment anything appeared, so a one-word
  // reply covered as much of the screen as a long one. On an always-on-top overlay
  // sitting over the window you are working in, that is most of the cost of using
  // it. Measured through the short message the previous step left on screen.
  const shortAnswerHeight = (await measure(page)).requestedWindowHeight;
  record(
    "the answer panel is sized to the answer, not to the screen",
    shortAnswerHeight !== null &&
      shortAnswerHeight > HUD_RESTING_HEIGHT &&
      shortAnswerHeight < 600,
    `a short message asked for ${shortAnswerHeight}px (was a flat 600px)`
  );

  // 9. the clipboard peek must not re-arm when the prompt is emptied.
  //
  // Deleting a prompt used to re-read the clipboard and offer the just-deleted
  // text straight back behind a paste icon, while the native window grew to fit
  // the bar. To the user that is a delete key that undoes itself.
  //
  // On a page of its own: the stub has to be installed before the app mounts, and
  // arming the peek on the shared page would have changed the requested window
  // height that every earlier assertion measures.
  await context.addInitScript((text) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => text },
    });
  }, STUB_CLIPBOARD);

  const peekPage = await context.newPage();
  watchForErrors(peekPage, "peek");
  await peekPage.setViewportSize({ width: HUD_WIDTH, height: 320 });
  await peekPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const peekPrompt = peekPage.getByPlaceholder(PROMPT_PLACEHOLDER);
  await peekPrompt.waitFor({ state: "visible", timeout: 15000 });
  await peekPage.waitForTimeout(600);

  const peekBar = peekPage.locator('[data-slot="clipboard-peek-dismiss"]');
  const peekArmed = await peekBar.count();
  const peekOverflows = await peekPage.evaluate(() => {
    const dismiss = document.querySelector('[data-slot="clipboard-peek-dismiss"]');
    const bar = dismiss?.closest("[data-hud-overlay]");
    if (!bar) return null;
    return {
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      dismissInside:
        dismiss.getBoundingClientRect().right <=
        bar.getBoundingClientRect().right + 0.5,
    };
  });
  await peekPage.screenshot({ path: join(OUT, "7-clipboard-peek.png") });

  await peekPrompt.click();
  await peekPrompt.pressSequentially("typing over the peek declines it");
  await peekPage.waitForTimeout(300);
  const peekWhileTyped = await peekBar.count();
  await peekPrompt.fill("");
  await peekPage.waitForTimeout(600);
  const peekAfterDelete = await peekBar.count();
  record(
    "emptying the prompt does not re-arm the clipboard peek",
    peekArmed === 1 && peekWhileTyped === 0 && peekAfterDelete === 0,
    `peek bar on summon=${peekArmed}, with text=${peekWhileTyped}, ` +
      `after deleting the whole prompt=${peekAfterDelete}`
  );
  record(
    "the peek bar keeps its dismiss control inside the bar",
    peekOverflows !== null &&
      peekOverflows.scrollWidth <= peekOverflows.clientWidth &&
      peekOverflows.dismissInside,
    peekOverflows
      ? `bar scrollWidth=${peekOverflows.scrollWidth} clientWidth=${peekOverflows.clientWidth}, ` +
        `dismiss inside=${peekOverflows.dismissInside}`
      : "no peek bar found to measure"
  );

  // Escape is the keyboard route out of the bar. Fresh page, because the value
  // above is now marked as already offered and will not be pushed twice.
  const escapePage = await context.newPage();
  watchForErrors(escapePage, "escape");
  await escapePage.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const escapePrompt = escapePage.getByPlaceholder(PROMPT_PLACEHOLDER);
  await escapePrompt.waitFor({ state: "visible", timeout: 15000 });
  await escapePage.waitForTimeout(600);
  const escapeBar = escapePage.locator('[data-slot="clipboard-peek-dismiss"]');
  const barBeforeEscape = await escapeBar.count();
  await escapePrompt.click();
  await escapePrompt.press("Escape");
  await escapePage.waitForTimeout(400);
  const barAfterEscape = await escapeBar.count();
  record(
    "Escape dismisses the clipboard peek",
    barBeforeEscape === 1 && barAfterEscape === 0,
    `peek bar ${barBeforeEscape} -> ${barAfterEscape} after Escape`
  );

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
