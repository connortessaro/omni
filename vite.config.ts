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

/**
 * Serves the VAD model/runtime assets that @ricky0123/vad-web fetches at
 * startup: the Silero ONNX model, its audio worklet, and the onnxruntime-web
 * wasm binaries. Upstream defaults point these at jsdelivr
 * (baseAssetPath/onnxWASMBasePath), and the app's CSP deliberately does not
 * allow that host -- connect-src and script-src stay locked to 'self' rather
 * than growing an allowlist for one dependency. So these ship from
 * node_modules as same-origin static assets instead, at /vad/<basename> in
 * dev and dist/vad/<basename> in the build, matching the baseAssetPath and
 * onnxWASMBasePath set in AutoSpeechVad.tsx.
 */
const vadAssetSources = [
  path.resolve(
    __dirname,
    "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx"
  ),
  path.resolve(
    __dirname,
    "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js"
  ),
  path.resolve(
    __dirname,
    "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm"
  ),
  path.resolve(__dirname, "node_modules/onnxruntime-web/dist/ort-wasm.wasm"),
];

for (const source of vadAssetSources) {
  if (!fs.existsSync(source)) {
    throw new Error(`vadAssets: missing source file ${source}`);
  }
}

const vadContentType = (filePath: string): string => {
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".js")) return "text/javascript";
  return "application/octet-stream";
};

const vadAssets = (): PluginOption => ({
  name: "omni-vad-assets",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      if (!url.startsWith("/vad/")) return next();
      const basename = url.slice("/vad/".length).split("?")[0];
      const source = vadAssetSources.find(
        (candidate) => path.basename(candidate) === basename
      );
      if (!source) return next();
      res.setHeader("Content-Type", vadContentType(source));
      res.end(fs.readFileSync(source));
    });
  },
  generateBundle() {
    for (const source of vadAssetSources) {
      this.emitFile({
        type: "asset",
        fileName: `vad/${path.basename(source)}`,
        source: fs.readFileSync(source),
      });
    }
  },
});

// https://vite.dev/config/
// Annotated rather than inferred: without the annotation the object literal is not
// contextually typed and defineConfig fails to match any overload.
const config: UserConfig = {
  plugins: [harnessMock(), vadAssets(), react(), tailwindcss()],
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
