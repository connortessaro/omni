// Clones a repo fixture at its pinned commit so the tree can be opened in an
// editor, screenshotted, or read from.
//
// The tree is not committed here: it is thousands of third-party files, and a
// pinned commit plus this script reproduces it exactly. Clones land in
// evals/.cache/repos/, which is already gitignored.
//
// Usage: node scripts/fetch-repo-fixture.mjs requests-2674
//        node scripts/fetch-repo-fixture.mjs --list

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES = join(ROOT, "evals/fixtures/repo");
const CACHE = join(ROOT, "evals/.cache/repos");

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

const slugs = () =>
  readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const [slug] = process.argv.slice(2);

if (!slug || slug === "--list") {
  console.log(slugs().join("\n") || "No fixtures in evals/fixtures/repo.");
  process.exit(slug ? 0 : 2);
}

const fixtureDir = join(FIXTURES, slug);
if (!existsSync(join(fixtureDir, "fixture.json"))) {
  console.error(
    `No fixture.json at ${fixtureDir}. Known fixtures: ${slugs().join(", ")}`
  );
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(join(fixtureDir, "fixture.json"), "utf8"));
const target = join(CACHE, slug);

if (existsSync(target)) {
  const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head === fixture.baseCommit) {
    console.log(`${target} is already at ${fixture.baseCommit}.`);
    process.exit(0);
  }
  console.log(`${target} is at ${head}, not ${fixture.baseCommit}; re-cloning.`);
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(CACHE, { recursive: true });

// A full clone, because a shallow one cannot check out an arbitrary old commit.
console.log(`Cloning ${fixture.repo} into ${target}...`);
run("git", ["clone", `https://github.com/${fixture.repo}.git`, target]);
run("git", ["-C", target, "checkout", "--detach", fixture.baseCommit]);

const fileCount = execFileSync("git", ["-C", target, "ls-files"], {
  encoding: "utf8",
})
  .trim()
  .split("\n").length;

console.log(
  `\n${fixture.instanceId} ready at ${target}\n` +
    `  commit ${fixture.baseCommit}\n` +
    `  ${fileCount} tracked files\n` +
    `  issue: ${join(fixtureDir, "issue.md")}`
);
