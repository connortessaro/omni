// Verifies every Tauri command the frontend invokes is actually registered in
// Rust, and reports registered commands nothing calls.
//
// This exists because a broken button shipped: speech/index.tsx invoked
// "capture_screenshot", which was never in generate_handler!. It failed
// silently into a console.error, and tsc, vite build, and cargo check all
// passed. Nothing in the type system spans the IPC boundary, so it needs a
// check of its own.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** Commands the Rust side exposes via generate_handler!. */
const registeredCommands = () => {
  const source = readFileSync(LIB_RS, "utf8");
  const start = source.indexOf("generate_handler![");
  if (start === -1) throw new Error("generate_handler! not found in lib.rs");
  const end = source.indexOf("])", start);
  const block = source.slice(start + "generate_handler![".length, end);

  return new Set(
    block
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      // `window::set_window_height` is invoked from JS as `set_window_height`.
      .map((entry) => entry.split("::").pop())
  );
};

/** Commands the frontend calls, with where it calls them. */
const invokedCommands = () => {
  const found = new Map();
  const pattern = /\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g;

  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const command = match[1];
      // Plugin commands are handled by the plugin, not by generate_handler!.
      if (command.startsWith("plugin:")) continue;
      const line = source.slice(0, match.index).split("\n").length;
      const site = `${relative(REPO_ROOT, file)}:${line}`;
      const sites = found.get(command) ?? [];
      sites.push(site);
      found.set(command, sites);
    }
  }

  return found;
};

const registered = registeredCommands();
const invoked = invokedCommands();

const missing = [...invoked.entries()].filter(
  ([command]) => !registered.has(command)
);
const unused = [...registered].filter((command) => !invoked.has(command));

for (const [command, sites] of missing) {
  console.error(`MISSING  ${command}`);
  for (const site of sites) console.error(`         called at ${site}`);
  console.error(`         not in generate_handler! in src-tauri/src/lib.rs`);
}

for (const command of unused) {
  console.log(`unused   ${command} is registered but nothing invokes it`);
}

console.log(
  `\n${registered.size} registered, ${invoked.size} invoked, ${missing.length} missing, ${unused.length} unused`
);

if (missing.length > 0) {
  console.error(
    `\n${missing.length} command(s) would fail at runtime. Register them or fix the call site.`
  );
  process.exitCode = 1;
}
