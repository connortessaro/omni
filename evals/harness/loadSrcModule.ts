import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CACHE_DIR = path.join(REPO_ROOT, "evals", ".cache");
const TSCONFIG_PATH = path.join(REPO_ROOT, "tsconfig.json");

/**
 * Bundles a single file from the real `src/` tree with esbuild (honoring the
 * project's own tsconfig `@/*` path aliases) and dynamically imports the
 * result. This is how the harness gets at Omni's production request-assembly
 * code (which uses `@/...` imports) from a plain Node script without
 * touching any file under `src/`.
 *
 * `@tauri-apps/*` imports inside the bundled graph are left external and
 * resolved by Node from the repo's own node_modules; they are never invoked
 * for any provider shipped in src/config/ai-providers.constants.ts because
 * every one of those curl templates targets a plain http(s) URL, so
 * fetchAIResponse's own `url.includes("http") ? fetch : tauriFetch` branch
 * always picks the standard global `fetch` — the one this harness controls.
 */
export interface LoadOptions {
  /**
   * Bare specifiers to redirect at bundle time, e.g. pointing
   * `@tauri-apps/plugin-sql` at an in-memory stub so the real database layer
   * can be exercised in Node without touching production code.
   */
  alias?: Record<string, string>;
}

export async function loadSrcModule<T>(
  relativeToSrc: string,
  options: LoadOptions = {}
): Promise<T> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const entry = path.join(REPO_ROOT, "src", relativeToSrc);
  const outfile = path.join(CACHE_DIR, `${randomUUID()}.mjs`);

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    packages: "external",
    alias: options.alias,
    tsconfig: TSCONFIG_PATH,
    logLevel: "silent",
  });

  try {
    return (await import(pathToFileURL(outfile).href)) as T;
  } finally {
    rmSync(outfile, { force: true });
  }
}
