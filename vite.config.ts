import { defineConfig, type PluginOption, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * Injects the Tauri IPC mock so the real UI runs in a plain browser.
 *
 * Dev-server only and opt-in via OMNI_HARNESS=1 (`npm run dev:live`), so a normal
 * `npm run dev` under `tauri dev` still talks to the actual Rust backend and the
 * production build never sees this at all. Inlined rather than linked, because the
 * mock has to be in place before any app code reads window.__TAURI_INTERNALS__.
 */
const harnessMock = (): PluginOption => ({
  name: "omni-harness-mock",
  apply: "serve",
  transformIndexHtml() {
    if (process.env.OMNI_HARNESS !== "1") return [];
    const mock = fs.readFileSync(
      path.resolve(__dirname, "dev-harness/tauri-mock.js"),
      "utf8"
    );
    const seed = fs.readFileSync(
      path.resolve(__dirname, "dev-harness/seed-settings.js"),
      "utf8"
    );
    return [
      { tag: "script", children: mock, injectTo: "head-prepend" },
      { tag: "script", children: seed, injectTo: "head-prepend" },
    ];
  },
});

// https://vite.dev/config/
// Annotated rather than inferred: without the annotation the object literal is not
// contextually typed and defineConfig fails to match any overload.
const config: UserConfig = {
  plugins: [harnessMock(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    cssMinify: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          markdown: [
            "shiki",
            "rehype-katex",
            "remark-gfm",
            "remark-math",
            "streamdown",
          ],
          ui: [
            "lucide-react",
            "class-variance-authority",
            "clsx",
            "tailwind-merge",
          ],
        },
      },
    },
  },
};

export default defineConfig(async () => config);
