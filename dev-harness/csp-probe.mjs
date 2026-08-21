// Loads the shipped VAD assets under the shipped production CSP, in WebKit.
//
// This exists because the microphone was dead from `eb8b2ce` to `5696df7` and
// nothing caught it. @ricky0123/vad-web defaults its asset paths to jsdelivr,
// the CSP added in that commit blocks the host, and the library reports the
// failure only through a `errored` flag the UI was not reading. So a build with
// a completely non-functional mic passed every check we had.
//
// WebKit on purpose: the app ships inside WKWebView, and WebKit gates
// WebAssembly compilation on the CSP even for same-origin wasm, which Chromium
// does not. A Chromium probe would pass on a policy the real app rejects.
//
// The CSP is read from tauri.conf.json rather than duplicated, so tightening the
// policy shows up here instead of in a user's silent dead microphone.
//
// Usage: npm run build   (this reads dist/vad, i.e. what actually ships)
//        npm run csp:probe
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST_VAD = join(ROOT, "dist", "vad");
const PORT = Number(process.env.CSP_PROBE_PORT ?? 1499);

/** The CDN the library defaults to. Must stay unreachable. */
const CDN_ASSET =
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/silero_vad_legacy.onnx";

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

const csp = () => {
  const conf = JSON.parse(
    readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const value = conf?.app?.security?.csp;
  if (!value) throw new Error("no app.security.csp in tauri.conf.json");
  return value;
};

/**
 * The three assets @ricky0123/vad-web loads at startup, each behind a different
 * directive. `wasm` is the one that needs 'wasm-unsafe-eval'.
 */
const assets = () => {
  if (!existsSync(DIST_VAD)) {
    throw new Error(`${DIST_VAD} not found. Run \`npm run build\` first.`);
  }
  const pick = (predicate, label) => {
    const names = readdirSync(DIST_VAD).filter(predicate);
    if (names.length === 0) throw new Error(`no ${label} in ${DIST_VAD}`);
    return names;
  };
  const model = pick((n) => n.endsWith(".onnx"), "onnx model");
  const worklet = pick((n) => n.includes("worklet"), "worklet bundle");
  // Prefer the SIMD build, which is what onnxruntime-web picks when available.
  const wasm = pick((n) => n.endsWith(".wasm"), "ort wasm");
  return {
    model: model.sort()[0],
    worklet: worklet[0],
    wasm: wasm.find((n) => n.includes("simd")) ?? wasm[0],
  };
};

const contentType = (name) => {
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".js")) return "text/javascript";
  if (name.endsWith(".html")) return "text/html";
  return "application/octet-stream";
};

const page = () => `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>csp-probe</title></head>
  <body><script src="/csp-probe.js"></script></body>
</html>`;

const script = (a) => `
window.__RESULT__ = { violations: [], steps: {} };
document.addEventListener("securitypolicyviolation", (e) => {
  window.__RESULT__.violations.push({
    directive: e.violatedDirective,
    blocked: e.blockedURI,
  });
});
const step = async (name, fn) => {
  try {
    window.__RESULT__.steps[name] = { ok: true, detail: await fn() };
  } catch (e) {
    window.__RESULT__.steps[name] = { ok: false, detail: String(e) };
  }
};
window.__RUN__ = async () => {
  await step("connect-src allows the model fetch", async () => {
    const r = await fetch("/vad/${a.model}");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return (await r.arrayBuffer()).byteLength + " bytes of ${a.model}";
  });
  await step("script-src allows compiling the ort wasm", async () => {
    const r = await fetch("/vad/${a.wasm}");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const m = await WebAssembly.compile(await r.arrayBuffer());
    return "${a.wasm} compiled, " + WebAssembly.Module.exports(m).length + " exports";
  });
  await step("script-src allows the audio worklet module", async () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule("/vad/${a.worklet}");
    await ctx.close();
    return "${a.worklet} registered";
  });
  await step("the upstream CDN default stays blocked", async () => {
    try {
      await fetch(${JSON.stringify(CDN_ASSET)});
    } catch (e) {
      return "refused (" + String(e).slice(0, 48) + ")";
    }
    throw new Error("the CDN fetch succeeded, so the CSP is not being enforced");
  });
  return window.__RESULT__;
};
`;

const run = async () => {
  const policy = csp();
  const a = assets();
  console.log(`CSP:    ${policy}`);
  console.log(`assets: ${a.model}, ${a.wasm}, ${a.worklet}\n`);

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    res.setHeader("Content-Security-Policy", policy);
    if (url === "/" || url === "/index.html") {
      res.setHeader("Content-Type", "text/html");
      return res.end(page());
    }
    if (url === "/csp-probe.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(script(a));
    }
    if (url.startsWith("/vad/")) {
      const name = basename(url);
      const file = join(DIST_VAD, name);
      if (existsSync(file)) {
        res.setHeader("Content-Type", contentType(name));
        return res.end(readFileSync(file));
      }
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const browser = await webkit.launch();
  try {
    const tab = await browser.newPage();
    const consoleErrors = [];
    tab.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    tab.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await tab.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

    // The probe's own script is external because script-src is 'self' with no
    // 'unsafe-inline'. If it did not run, the page is misconfigured and every
    // assertion below would be vacuous.
    const armed = await tab.evaluate(() => typeof window.__RUN__ === "function");
    record(
      "the probe page itself loads under the policy",
      armed,
      armed ? "window.__RUN__ present" : `blocked: ${consoleErrors.join(" | ")}`
    );
    if (!armed) return;

    const result = await tab.evaluate(() => window.__RUN__());
    for (const [name, r] of Object.entries(result.steps)) {
      record(name, r.ok, r.detail);
    }

    const cdnViolation = result.violations.some((v) =>
      v.blocked.includes("cdn.jsdelivr.net")
    );
    record(
      "the CDN block is reported as a CSP violation",
      cdnViolation,
      cdnViolation
        ? "connect-src violation observed"
        : `violations: ${JSON.stringify(result.violations)}`
    );

    const unexpected = result.violations.filter(
      (v) => !v.blocked.includes("cdn.jsdelivr.net")
    );
    record(
      "no other CSP violation fires",
      unexpected.length === 0,
      unexpected.length ? JSON.stringify(unexpected) : "none"
    );
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error("csp-probe crashed:", error);
  process.exitCode = 1;
});
