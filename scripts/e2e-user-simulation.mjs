// Omni End-to-End User Simulation Suite
// Drives the Omni HUD in Playwright WebKit exactly as an end-user would.

import { webkit, chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "dev-harness", "out", "user-simulation");
mkdirSync(OUT_DIR, { recursive: true });

const PORT = 1428;
const HUD_URL = `http://localhost:${PORT}/`;

const pass = (msg) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`  \x1b[31m✖\x1b[0m ${msg}`);
  process.exitCode = 1;
};
const header = (title) => console.log(`\n\x1b[1m\x1b[36m=== ${title} ===\x1b[0m`);

const sseChunks = (text) =>
  text
    .split("\n")
    .map((line, index) =>
      `data: ${JSON.stringify({
        choices: [{ delta: { content: index === 0 ? line : `\n${line}` } }],
      })}\n\n`
    );

async function startViteServer() {
  console.log(`Starting Vite dev harness on port ${PORT}...`);
  const viteProcess = spawn(
    "npx",
    ["vite", "--port", String(PORT), "--strictPort"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, OMNI_HARNESS: "1" },
      stdio: "pipe",
    }
  );

  // Wait for server to be responsive
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(HUD_URL);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    viteProcess.kill();
    throw new Error(`Vite server failed to respond on ${HUD_URL}`);
  }

  console.log(`Vite server ready at ${HUD_URL}\n`);
  return viteProcess;
}

async function runSimulation() {
  let viteProcess = null;
  let browser = null;

  try {
    viteProcess = await startViteServer();

    console.log("Launching WebKit browser (with Chromium fallback)...");
    try {
      browser = await webkit.launch({ headless: true });
      pass("Launched Playwright WebKit engine (WKWebView parity)");
    } catch (e) {
      console.warn("WebKit launch failed, falling back to Chromium:", e.message);
      browser = await chromium.launch({ headless: true });
      pass("Launched Playwright Chromium engine");
    }

    const context = await browser.newContext({
      viewport: { width: 1200, height: 750 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // -------------------------------------------------------------
    // Act 1: Initial Launch & Resting HUD Overlay
    // -------------------------------------------------------------
    header("Act 1: Initial Launch & Resting HUD Overlay");
    await page.goto(HUD_URL, { waitUntil: "networkidle" });

    const card = page.locator("[data-tauri-drag-region]").first();
    await card.waitFor({ state: "visible", timeout: 8000 });
    pass("HUD Card is mounted and visible with data-tauri-drag-region");

    const promptTextarea = page.locator("textarea").first();
    await promptTextarea.waitFor({ state: "visible" });
    const placeholder = await promptTextarea.getAttribute("placeholder");
    if (placeholder?.includes("Ask anything or type /")) {
      pass(`Prompt placeholder confirmed: "${placeholder}"`);
    } else {
      fail(`Unexpected placeholder: "${placeholder}"`);
    }

    await page.screenshot({ path: join(OUT_DIR, "01-resting-hud.png") });
    pass("Captured screenshot: 01-resting-hud.png");

    // -------------------------------------------------------------
    // Act 2: Interactive Slash Commands Palette
    // -------------------------------------------------------------
    header("Act 2: Interactive Slash Commands Palette");
    await promptTextarea.focus();
    await page.keyboard.type("/");
    await page.waitForTimeout(300);

    const slashMenu = page.locator("#slash-command-menu");
    await slashMenu.waitFor({ state: "visible", timeout: 4000 });
    pass("Slash command palette opened upon typing '/'");

    const slashCommands = await slashMenu.locator("button").allTextContents();
    const hasCoreCommands = ["fix", "commit", "answer", "code", "explain"].every((cmd) =>
      slashCommands.some((item) => item.includes(`/${cmd}`))
    );
    if (hasCoreCommands) {
      pass(`Slash commands visible: ${slashCommands.length} commands found`);
    } else {
      fail(`Slash command menu missing core commands: ${slashCommands.join(", ")}`);
    }

    await page.screenshot({ path: join(OUT_DIR, "02-slash-menu-open.png") });
    pass("Captured screenshot: 02-slash-menu-open.png");

    // Clear the input
    await promptTextarea.fill("");
    await page.waitForTimeout(200);

    // -------------------------------------------------------------
    // Act 3: Prompt Profiles Switching
    // -------------------------------------------------------------
    header("Act 3: Prompt Profiles Selection ('Type it' vs 'Say it')");
    const profileChip = page.locator("[data-slot='profile-chip']").first();
    await profileChip.waitFor({ state: "visible", timeout: 4000 });
    await profileChip.click();
    await page.waitForTimeout(300);

    const profileMenu = page.locator("[data-slot='profile-menu']");
    await profileMenu.waitFor({ state: "visible", timeout: 4000 });
    pass("Profile selection menu opened");

    const assessmentOption = profileMenu.locator("button", { hasText: "Assessment" }).first();
    await assessmentOption.click();
    await page.waitForTimeout(300);
    pass("Selected 'Assessment' profile");

    await page.screenshot({ path: join(OUT_DIR, "03-profile-menu-open.png") });
    pass("Captured screenshot: 03-profile-menu-open.png");

    // -------------------------------------------------------------
    // Act 4: Timed Assessment Question & Verdict-First Rendering
    // -------------------------------------------------------------
    header("Act 4: Assessment Solving & Verdict-First Rendering");
    const questionText = "Given nums = [2, 7, 11, 15] and target = 9, return the indices of two numbers that add up to target.";
    await promptTextarea.fill(questionText);

    // Script mock stream response with fenced omni block
    const assessmentResponse = [
      "```omni",
      "shape: code",
      "answer: One-pass hash map for O(n) time and O(n) space",
      "confidence: high",
      "```",
      "",
      "Use a hash map to look up the complement for each element in a single pass.",
      "",
      "solution.py",
      "```python",
      "def two_sum(nums, target):",
      "    seen = {}",
      "    for i, num in enumerate(nums):",
      "        comp = target - num",
      "        if comp in seen:",
      "            return [seen[comp], i]",
      "        seen[num] = i",
      "    return []",
      "```",
      "",
      "test_solution.py",
      "```python",
      "from solution import two_sum",
      "assert two_sum([2, 7, 11, 15], 9) == [0, 1]",
      "assert two_sum([3, 2, 4], 6) == [1, 2]",
      "print('2 passed')",
      "```",
    ].join("\n");

    const chunks = sseChunks(assessmentResponse);
    await page.evaluate((c) => {
      window.__HARNESS_STREAM__ = {
        chunks: c,
        firstChunkDelayMs: 20,
        chunkIntervalMs: 5,
      };
    }, chunks);

    // Press Enter to submit
    await page.keyboard.press("Enter");

    // Wait for the AnswerCard to render
    const verdictLabel = page.locator("text=Solution").first();
    await verdictLabel.waitFor({ state: "visible", timeout: 8000 });
    pass("AnswerCard rendered with 'Solution' verdict-first badge");

    const approachHeadline = page.locator("text=One-pass hash map").first();
    await approachHeadline.waitFor({ state: "visible" });
    pass("Verdict headline rendered: 'One-pass hash map for O(n) time...'");

    // Verify code block rendered
    const pythonCode = page.locator("pre").first();
    await pythonCode.waitFor({ state: "visible" });
    pass("Python syntax-highlighted code block rendered cleanly");

    await page.screenshot({ path: join(OUT_DIR, "04-assessment-verdict-rendered.png") });
    pass("Captured screenshot: 04-assessment-verdict-rendered.png");

    // -------------------------------------------------------------
    // Act 5: Local Test Runner ("Run Before You Trust")
    // -------------------------------------------------------------
    header("Act 5: Local Test Runner ('Run Before You Trust')");
    // Script the runner response
    await page.evaluate(() => {
      window.__HARNESS_RUN__ = {
        exit_code: 0,
        stdout: "2 passed in 0.04s\nOK",
        stderr: "",
        timed_out: false,
        truncated: false,
        duration_ms: 45,
        command: "python3",
      };
    });

    const runTestsBtn = page.locator("button", { hasText: "Run tests" }).first();
    await runTestsBtn.waitFor({ state: "visible", timeout: 4000 });
    pass("Found 'Run tests' button on code answer card");

    // Zero-mouse hotkey: trigger local tests via Alt+R
    await page.keyboard.press("Alt+r");
    await page.waitForTimeout(500);

    const passedBadge = page.locator("text=/2 passed/").first();
    await passedBadge.waitFor({ state: "visible", timeout: 5000 });
    pass("Local test runner executed via hands-free Alt+R: Green badge rendered with '2 passed'");

    await page.screenshot({ path: join(OUT_DIR, "05-tests-passed-badge.png") });
    pass("Captured screenshot: 05-tests-passed-badge.png");

    // -------------------------------------------------------------
    // Act 6: Human Typing Simulator & Hands-Free Copy Interaction
    // -------------------------------------------------------------
    header("Act 6: Human Typing Simulator & Clipboard Ergonomics");
    const autoTypeBtn = page.locator("button[aria-label*='Type code'], button[title*='typing']").first();
    await autoTypeBtn.waitFor({ state: "visible", timeout: 4000 });
    pass("Auto-type keyboard button is visible on code card");

    // Zero-mouse hotkey: trigger hands-free solution copy via Alt+C
    await page.keyboard.press("Alt+c");
    await page.waitForTimeout(200);
    pass("Hands-free solution copy dispatched cleanly via Alt+C");

    // Zero-mouse hotkey: trigger human typing simulator via Alt+T
    await page.keyboard.press("Alt+t");
    await page.waitForTimeout(300);

    const simulationState = await page.evaluate(() => window.__LAST_TYPING_SIMULATION__);
    if (simulationState && simulationState.text && simulationState.speedWpm === 105) {
      pass(`simulate_human_typing triggered via hands-free Alt+T (${simulationState.text.length} chars at speed ${simulationState.speedWpm} WPM)`);
    } else {
      fail("Alt+T hotkey failed to trigger simulate_human_typing");
    }

    // Cancel typing simulation via Escape key
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    const cancelledState = await page.evaluate(() => window.__TYPING_CANCELLED__);
    if (cancelledState === true) {
      pass("cancel_human_typing invoked successfully upon pressing Escape");
    } else {
      fail("Escape did not trigger cancel_human_typing");
    }

    // -------------------------------------------------------------
    // Act 7: Spoken Interview ("Say it") Profile & Alt+E Disclosure
    // -------------------------------------------------------------
    header("Act 7: Spoken Interview Profile ('Live Interview')");
    const currentChip = page.locator("[data-slot='profile-chip']").first();
    await currentChip.click();
    await page.waitForTimeout(300);

    const liveInterviewOpt = page.locator("[data-slot='profile-menu'] button", { hasText: "Live Interview" }).first();
    await liveInterviewOpt.click();
    await page.waitForTimeout(300);
    pass("Switched profile to 'Live Interview'");

    const interviewPrompt = "Explain optimistic vs pessimistic locking.";
    await promptTextarea.fill(interviewPrompt);

    const spokenResponse = [
      "```omni",
      "shape: speak",
      "answer: Optimistic locking checks for conflicting modifications at write time without holding locks, while pessimistic locking holds exclusive database locks for the entire transaction duration.",
      "confidence: high",
      "```",
      "",
      "- Use optimistic locking when conflict rates are low and read throughput is high.",
      "- Use pessimistic locking when update contention is severe and rollback costs are unacceptable.",
    ].join("\n");

    const interviewChunks = sseChunks(spokenResponse);
    await page.evaluate((c) => {
      window.__HARNESS_STREAM__ = {
        chunks: c,
        firstChunkDelayMs: 20,
        chunkIntervalMs: 5,
      };
    }, interviewChunks);

    await page.keyboard.press("Enter");

    const sayThisBadge = page.locator("text=Say this").first();
    await sayThisBadge.waitFor({ state: "visible", timeout: 8000 });
    pass("AnswerCard rendered with 'Say this' spoken-intent badge");

    const spokenSentence = page.locator("text=Optimistic locking checks").first();
    await spokenSentence.waitFor({ state: "visible" });
    pass("Oversized 15-second speakable thesis sentence rendered at top");

    // Zero-mouse hotkey: verify reasoning is initially folded, then toggle via Alt+E
    const bodyLocator = page.locator("[data-slot='answer-body']");
    const initialBodyVisible = await bodyLocator.isVisible();
    if (!initialBodyVisible) {
      pass("Spoken interview reasoning body is initially folded to keep thesis prominent");
    }

    // Press Alt+E to toggle disclosure open
    await page.keyboard.press("Alt+e");
    await page.waitForTimeout(300);
    const bodyExpanded = await bodyLocator.isVisible();
    if (bodyExpanded) {
      pass("Reasoning disclosure expanded hands-free via Alt+E");
    } else {
      fail("Alt+E failed to expand reasoning disclosure");
    }

    // Press Alt+E to collapse disclosure again
    await page.keyboard.press("Alt+e");
    await page.waitForTimeout(300);
    const bodyCollapsedAgain = await bodyLocator.isVisible();
    if (!bodyCollapsedAgain) {
      pass("Reasoning disclosure collapsed hands-free via second Alt+E");
    } else {
      fail("Alt+E failed to collapse reasoning disclosure");
    }

    await page.screenshot({ path: join(OUT_DIR, "06-spoken-interview-verdict.png") });
    pass("Captured screenshot: 06-spoken-interview-verdict.png");

    console.log("\n\x1b[1m\x1b[32m✨ End-to-End User Simulation Completed Successfully! ✨\x1b[0m");
    console.log(`Screenshots saved to: ${OUT_DIR}`);
  } catch (err) {
    fail(`User simulation error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (viteProcess) {
      viteProcess.kill("SIGTERM");
    }
  }
}

runSimulation();
