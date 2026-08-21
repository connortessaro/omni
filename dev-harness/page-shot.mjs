// Screenshot any app route at any viewport, in the engine the app ships in.
//
// probe.mjs asserts; this one only looks. It exists because the dashboard pages
// are not the HUD: they are wider than 600px, they are reached by route rather
// than by typing into a prompt, and reviewing one means seeing it at desktop and
// at ~390px rather than measuring a bounding box. WebKit rather than Chromium for
// the same reason probe.mjs uses it — the app runs in WKWebView, and Chromium
// supports CSS that WebKit does not.
//
// Usage (with `npm run dev` already serving):
//   node dev-harness/page-shot.mjs --route /system-prompts
//   node dev-harness/page-shot.mjs --route / --viewport 600x54 --name hud
//   node dev-harness/page-shot.mjs --route /responses --viewport 390x844
//
// Writes dev-harness/out/shot-<name>-<width>x<height>.png.

import { webkit } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";

const parseArgs = (argv) => {
  const args = { route: "/", viewports: [], name: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--route") {
      args.route = value;
      i++;
    } else if (flag === "--viewport") {
      const [width, height] = value.split("x").map(Number);
      if (!width || !height) {
        throw new Error(`--viewport wants WxH, got "${value}"`);
      }
      args.viewports.push({ width, height });
      i++;
    } else if (flag === "--name") {
      args.name = value;
      i++;
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }
  // Desktop and the narrowest phone the dashboard has to survive. Both, by
  // default, because a page reviewed at one width is a page half reviewed.
  if (args.viewports.length === 0) {
    args.viewports = [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ];
  }
  args.name ??= args.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
  return args;
};

const run = async () => {
  const { route, viewports, name } = parseArgs(process.argv.slice(2));
  mkdirSync(OUT, { recursive: true });

  const browser = await webkit.launch();
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  // Without the Tauri shim the app's plugin-sql and invoke calls reject on mount,
  // which is worth seeing rather than hiding: a page that only renders under a
  // working database is a page that breaks on a database that will not open.
  await context.addInitScript({
    content: readFileSync(join(HERE, "tauri-mock.js"), "utf8"),
  });

  const failures = [];
  for (const viewport of viewports) {
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      failures.push(`pageerror @${viewport.width}px: ${error.message}`)
    );
    page.on("console", (message) => {
      if (message.type() === "error") {
        failures.push(`console @${viewport.width}px: ${message.text()}`);
      }
    });
    await page.setViewportSize(viewport);
    await page.goto(new URL(route, APP_URL).href, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1200);
    const path = join(
      OUT,
      `shot-${name}-${viewport.width}x${viewport.height}.png`
    );
    await page.screenshot({ path, fullPage: true });
    console.log(`wrote ${path}`);
    await page.close();
  }

  await browser.close();

  if (failures.length) {
    console.log(`\n${failures.length} page fault(s) while rendering ${route}:`);
    for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
