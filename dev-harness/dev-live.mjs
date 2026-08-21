// Runs the Vite dev server with the Tauri mock injected, alongside the provider
// proxy that holds the API key. One command, and killing it kills both — an
// orphaned proxy holding a credential is not something to leave running.
//
// Usage: npm run dev:live

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const children = [];
let shuttingDown = false;

const start = (name, command, args, env) => {
  const child = spawn(command, args, {
    cwd: join(HERE, ".."),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push({ name, child });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `\n${name} exited (${signal ?? `code ${code}`}); shutting the rest down.`
    );
    shutdown(code ?? 1);
  });

  return child;
};

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

start("provider proxy", process.execPath, [join(HERE, "provider-proxy.mjs")]);
start("vite", "npx", ["vite"], { OMNI_HARNESS: "1" });
