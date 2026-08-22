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
 * Production sends every network request through @tauri-apps/plugin-http, which
 * cannot run outside Tauri, so it is aliased to a Node passthrough by default.
 * The passthrough calls globalThis.fetch, which means a script that stubs the
 * global (the dry run) still intercepts everything, and a script that does not
 * (a live run) reaches the real network. Callers can override this to point at a
 * recording stub instead.
 */
const TAURI_HTTP_SPECIFIER = "@tauri-apps/plugin-http";
const NODE_HTTP_PASSTHROUGH = path.join(
  __dirname,
  "node-http-passthrough.mjs"
);

/**
 * Provider requests go through a Tauri command now, so the transport module is
 * the seam rather than the HTTP plugin. esbuild's `alias` only accepts bare
 * package specifiers, and this is a relative import, so it is redirected with a
 * resolve plugin instead.
 */
const NODE_TRANSPORT = path.join(__dirname, "node-transport.mjs");

const transportRedirect = (target: string) => ({
  name: "redirect-transport",
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: () => { path: string }
    ) => void;
  }) {
    build.onResolve({ filter: /(^|\/)transport(\.ts)?$/ }, () => ({
      path: target,
    }));
  },
});

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
  /**
   * Replaces the Node transport with another module, so a test can record what
   * a request path assembled instead of issuing it.
   */
  transport?: string;
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
    alias: {
      [TAURI_HTTP_SPECIFIER]: NODE_HTTP_PASSTHROUGH,
      ...options.alias,
    },
    plugins: [transportRedirect(options.transport ?? NODE_TRANSPORT)],
    tsconfig: TSCONFIG_PATH,
    logLevel: "silent",
  });

  try {
    return (await import(pathToFileURL(outfile).href)) as T;
  } finally {
    rmSync(outfile, { force: true });
  }
}
