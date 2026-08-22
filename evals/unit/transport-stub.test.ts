// The harness replaces transport.ts wholesale, so the stub and the real module
// have to agree on their exported surface. A drift here does not fail a
// typecheck (one is a stub, one is production) and instead shows up as a test
// that passes against a shape production does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/loadSrcModule.ts";

const exportsOf = (relativePath: string): Set<string> => {
  const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  const names = new Set<string>();
  const pattern =
    /export\s+(?:async\s+)?(?:const|function\*?|interface)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.add(match[1]);
  return names;
};

const RUNTIME_EXPORTS = [
  "secretPlaceholder",
  "isSecretVariable",
  "secretExists",
  "streamProviderRequest",
];

test("the real transport exports everything a request path needs", () => {
  const real = exportsOf("src/lib/functions/transport.ts");
  for (const name of RUNTIME_EXPORTS) {
    assert.ok(real.has(name), `transport.ts must export ${name}`);
  }
  assert.ok(
    real.has("RequestUpload"),
    "transport.ts must declare the RequestUpload interface"
  );
});

test("both stand-ins export the same runtime surface", () => {
  const node = exportsOf("evals/harness/node-transport.mjs");
  const stub = exportsOf("evals/unit/stubs/transport.ts");

  for (const name of RUNTIME_EXPORTS) {
    assert.ok(node.has(name), `node-transport.mjs must export ${name}`);
    assert.ok(stub.has(name), `stubs/transport.ts must export ${name}`);
  }
});
