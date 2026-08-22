// Selects a speech-to-text provider by writing the webview's localStorage
// directly, for when you want the app configured without clicking through
// Settings.
//
// The selection Omni reads at startup is STORAGE_KEYS.SELECTED_STT_PROVIDER
// ("curl_selected_stt_provider") in localStorage, and localStorage for a Tauri
// WKWebView is a SQLite file on disk. Values are stored as UTF-16LE blobs with
// no BOM, which is why this writes a hex blob literal rather than text.
//
// The credential is never taken on the command line — it is read from
// ~/.config/omni/eval.env (mode 600, the same file the eval runner uses), so it
// stays out of shell history and out of this script's output.
//
// Usage:
//   node scripts/set-stt-provider.mjs --provider gemini-stt --model gemini-2.5-flash
//   node scripts/set-stt-provider.mjs --show
//
// Omni must be quit first: WKWebView holds the database open and would flush
// its own in-memory copy over anything written underneath it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ID = "com.connortessaro.omni";
const STORAGE_KEY = "curl_selected_stt_provider";
const ENV_FILE =
  process.env.OMNI_EVAL_ENV_FILE ?? join(homedir(), ".config/omni/eval.env");

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const showOnly = args.includes("--show");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Provider ids the app actually ships, read from the real constants file. */
const knownProviderIds = () => {
  const source = readFileSync(
    join(REPO_ROOT, "src/config/stt.constants.ts"),
    "utf8"
  );
  return [...source.matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((m) => m[1]);
};

/** Parses KEY=VALUE lines, ignoring blanks, comments and surrounding quotes. */
const readEnvFile = (path) => {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
};

/**
 * WebKit buries the store under two nested salt-named directories, so the leaf
 * is found by walking rather than by a fixed path.
 */
const findLocalStorageDb = () => {
  const base = join(
    homedir(),
    "Library/WebKit",
    BUNDLE_ID,
    "WebsiteData/Default"
  );
  if (!existsSync(base)) fail(`No webview data at ${base}. Has Omni ever run?`);

  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === "localstorage.sqlite3") return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  fail(`No localstorage.sqlite3 found under ${base}.`);
};

const sqlite = (db, sql) =>
  execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();

const isOmniRunning = () => {
  try {
    execFileSync("pgrep", ["-f", `/Applications/Omni.app/Contents/MacOS/omni`], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
};

const db = findLocalStorageDb();

if (showOnly) {
  const hex = sqlite(db, `select hex(value) from ItemTable where key='${STORAGE_KEY}';`);
  if (!hex) {
    console.log("No STT provider is selected.");
    process.exit(0);
  }
  const parsed = JSON.parse(Buffer.from(hex, "hex").toString("utf16le"));
  // The variables map holds the credential, so only its shape is reported.
  console.log(`provider: ${parsed.provider}`);
  console.log(`variables: ${Object.keys(parsed.variables ?? {}).join(", ")}`);
  process.exit(0);
}

const provider = flag("provider");
const model = flag("model");
if (!provider || !model) {
  fail("Usage: --provider <id> --model <name>   (or --show)");
}

const known = knownProviderIds();
if (!known.includes(provider)) {
  fail(
    `Unknown provider "${provider}". src/config/stt.constants.ts ships: ${known.join(", ")}`
  );
}

if (isOmniRunning()) {
  fail(
    "Omni is running. Quit it first — WKWebView would flush its own copy of\n" +
      "localStorage over this write."
  );
}

const env = readEnvFile(ENV_FILE);
const apiKey = process.env.OMNI_STT_API_KEY ?? env.OMNI_EVAL_API_KEY;
if (!apiKey) {
  fail(
    `No credential found. Set OMNI_STT_API_KEY, or put OMNI_EVAL_API_KEY in ${ENV_FILE}.`
  );
}

const value = JSON.stringify({
  provider,
  variables: { api_key: apiKey, model },
});
const hex = Buffer.from(value, "utf16le").toString("hex");

sqlite(
  db,
  `insert or replace into ItemTable (key, value) values ('${STORAGE_KEY}', x'${hex}');
   pragma wal_checkpoint(truncate);`
);

const readback = JSON.parse(
  Buffer.from(
    sqlite(db, `select hex(value) from ItemTable where key='${STORAGE_KEY}';`),
    "hex"
  ).toString("utf16le")
);

if (readback.provider !== provider || readback.variables.model !== model) {
  fail("Write did not read back as expected.");
}

console.log(`Selected ${provider} (model ${model}) with the key from ${ENV_FILE}.`);
console.log("Relaunch Omni to pick it up.");
