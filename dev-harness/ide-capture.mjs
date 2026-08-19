// Captures a browser IDE the way Omni's screenshot shortcut would, and records
// exactly what text was on screen at the moment of capture.
//
// This exists to answer one question with a number instead of an opinion: when the
// only view of a repo is a screenshot of a code editor in a browser, can a model
// read it? The DOM text of the captured region is the ground truth a transcription
// is scored against, so the score does not depend on guessing which lines were
// visible.
//
// Captures at deviceScaleFactor 2 as well as 1, because capture.rs grabs native
// pixels and a Retina screen doubles them, which changes both the byte size and
// what survives provider-side downscaling.
//
// Usage: node dev-harness/ide-capture.mjs \
//          --url "https://github.com/psf/requests/blob/0be38a0c/requests/adapters.py" \
//          --selector "#read-only-cursor-text-area" \
//          --out github-adapters
//
// --clip x,y,w,h captures a rect instead of the viewport, which is what Omni's
// region-select overlay does. The recorded ground truth is filtered to that rect.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A candidate's laptop, not a CI default. */
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const parseArgs = (argv) => {
  const args = { scales: [2, 1], waitMs: 4000, viewport: DEFAULT_VIEWPORT };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--url") { args.url = value; i++; }
    else if (argv[i] === "--selector") { args.selector = value; i++; }
    else if (argv[i] === "--out") { args.out = value; i++; }
    else if (argv[i] === "--wait") { args.waitMs = Number(value); i++; }
    else if (argv[i] === "--scale") { args.scales = [Number(value)]; i++; }
    else if (argv[i] === "--clip") {
      const [x, y, width, height] = value.split(",").map(Number);
      if ([x, y, width, height].some((n) => Number.isNaN(n))) {
        console.error(`--clip wants x,y,w,h in CSS pixels, got "${value}"`);
        process.exit(2);
      }
      args.clip = { x, y, width, height };
      i++;
    }
    else if (argv[i] === "--viewport") {
      const [width, height] = value.split("x").map(Number);
      if (!width || !height) {
        console.error(`--viewport wants WxH, got "${value}"`);
        process.exit(2);
      }
      args.viewport = { width, height };
      i++;
    }
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.url || !args.out) {
    console.error(
      "Usage: node dev-harness/ide-capture.mjs --url <url> --out <name> [--selector <css>] [--wait ms] [--scale n] [--viewport WxH] [--clip x,y,w,h]"
    );
    process.exit(2);
  }
  return args;
};

const { url, selector, out, waitMs, scales, viewport: VIEWPORT, clip } = parseArgs(process.argv.slice(2));
const OUT_DIR = join(HERE, "out", "ide", out);
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Text that was actually on screen. Element `innerText` already excludes what is
 * clipped by an ancestor's overflow, but not what is scrolled out of the viewport,
 * so a whole-page selector would overstate it. Filtered by the element's own rect
 * against the viewport for that reason.
 */
const visibleText = (page, css, clipRect) =>
  page.evaluate(({ cssSelector, clipRect }) => {
    const bounds = clipRect ?? {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };

    // A line counts as captured when its box sits inside the captured rect. Half a
    // line at the edge is unreadable, so require the whole thing.
    const withinCapture = (rect) =>
      rect.height > 0 &&
      rect.width > 0 &&
      rect.top >= bounds.y - 1 &&
      rect.bottom <= bounds.y + bounds.height + 1 &&
      rect.right > bounds.x &&
      rect.left < bounds.x + bounds.width;

    const root = cssSelector
      ? document.querySelector(cssSelector)
      : document.body;
    if (!root) return { text: "", found: false };

    // A textarea mirror (GitHub's read-only cursor) holds the whole file, not the
    // visible slice, so prefer rendered line elements when they exist.
    const lines = Array.from(
      document.querySelectorAll(
        '[data-testid="code-lines"] > div, .react-line-numbers ~ div > div, .view-line, .cm-line'
      )
    ).filter((line) => withinCapture(line.getBoundingClientRect()));

    if (lines.length > 0) {
      return {
        text: lines.map((line) => line.innerText).join("\n"),
        found: true,
        source: "rendered lines",
        lineCount: lines.length,
      };
    }

    return {
      text: root.innerText ?? "",
      found: true,
      source: cssSelector ? `innerText of ${cssSelector}` : "innerText of body",
    };
  }, { cssSelector: css ?? null, clipRect: clipRect ?? null });

const main = async () => {
  const results = [];

  for (const scale of scales) {
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: scale,
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Editors hydrate and lay out well after DOMContentLoaded.
    await page.waitForTimeout(waitMs);

    const seen = await visibleText(page, selector, clip);
    if (!seen.found) {
      console.error(
        `Selector ${selector} matched nothing at ${url}. ` +
          "The page may be showing a login wall or a different layout."
      );
      await page.screenshot({ path: join(OUT_DIR, `failed-${scale}x.png`) });
      await browser.close();
      process.exit(1);
    }

    const fullPath = join(OUT_DIR, `${clip ? "clip" : "full"}-${scale}x.png`);
    await page.screenshot({ path: fullPath, ...(clip ? { clip } : {}) });

    const capture = {
      scale,
      viewport: VIEWPORT,
      clip: clip ?? null,
      pixels: {
        width: Math.round((clip?.width ?? VIEWPORT.width) * scale),
        height: Math.round((clip?.height ?? VIEWPORT.height) * scale),
      },
      textSource: seen.source,
      visibleLines: seen.lineCount ?? null,
      visibleChars: seen.text.length,
      png: {
        path: fullPath,
        bytes: statSync(fullPath).size,
        base64Bytes: Math.ceil(statSync(fullPath).size / 3) * 4,
      },
    };

    // The region a user would select with the crop overlay, when they know to.
    if (selector) {
      const region = page.locator(selector).first();
      if ((await region.count()) > 0) {
        const regionPath = join(OUT_DIR, `region-${scale}x.png`);
        await region.screenshot({ path: regionPath }).catch(() => null);
        try {
          capture.region = {
            path: regionPath,
            bytes: statSync(regionPath).size,
            base64Bytes: Math.ceil(statSync(regionPath).size / 3) * 4,
          };
        } catch {
          capture.region = null;
        }
      }
    }

    writeFileSync(join(OUT_DIR, `visible-${scale}x.txt`), seen.text);
    results.push(capture);

    console.log(
      `${scale}x  ${capture.pixels.width}x${capture.pixels.height}  ` +
        `png=${(capture.png.bytes / 1024).toFixed(0)}KB  ` +
        `base64=${(capture.png.base64Bytes / 1024).toFixed(0)}KB  ` +
        `visible=${capture.visibleChars} chars via ${capture.textSource}`
    );

    await browser.close();
  }

  writeFileSync(
    join(OUT_DIR, "captures.json"),
    JSON.stringify({ url, selector: selector ?? null, captures: results }, null, 2)
  );
  console.log(`\nWrote ${OUT_DIR}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
