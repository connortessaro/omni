// Keeps provider credentials out of localStorage.
//
// The file behind localStorage is mode 644 and readable by any process running
// as the user with no prompt; the keychain copy is ACL-gated. That gap is the
// whole reason the credential store exists, and it is one careless setItem away
// from being reopened. Nothing in the type system spans it, so it needs a check
// of its own, the same reason check-commands.mjs exists.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** The only module allowed to write the selected-provider keys. */
const SOLE_WRITER = join("src", "lib", "storage", "selected-provider.ts");

/** Storage keys whose payload carries a provider's variables. */
const GUARDED_KEYS = ["SELECTED_AI_PROVIDER", "SELECTED_STT_PROVIDER"];

/**
 * How far past a `setItem(` to look for a guarded key. A call can span several
 * lines once prettier has wrapped it, so matching line by line would miss the
 * exact shape this check exists to catch.
 */
const CALL_WINDOW = 200;

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

const violations = [];

for (const file of walk(SRC)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relativePath = relative(REPO_ROOT, file);
  if (relativePath === SOLE_WRITER) continue;

  const source = readFileSync(file, "utf8");
  const pattern = /setItem\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + CALL_WINDOW);
    for (const key of GUARDED_KEYS) {
      if (window.includes(key)) {
        violations.push({
          site: `${relativePath}:${lineOf(source, match.index)}`,
          detail: `writes ${key} directly; use persistSelectedProvider from ${SOLE_WRITER}`,
        });
      }
    }
  }
}

// The stripper itself has to keep using the shared definition of "secret", or
// the two drift and a renamed variable slips through.
const writerSource = readFileSync(join(REPO_ROOT, SOLE_WRITER), "utf8");
if (!writerSource.includes("isSecretVariable")) {
  violations.push({
    site: SOLE_WRITER,
    detail:
      "does not use isSecretVariable from transport.ts, so it has its own idea of what a secret is",
  });
}

for (const { site, detail } of violations) {
  console.error(`LEAK  ${site}`);
  console.error(`      ${detail}`);
}

console.log(
  `\n${GUARDED_KEYS.length} guarded key(s), ${violations.length} violation(s)`
);

if (violations.length > 0) {
  console.error(
    `\n${violations.length} site(s) can persist a credential in plaintext.`
  );
  process.exitCode = 1;
}
