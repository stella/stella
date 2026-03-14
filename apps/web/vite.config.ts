import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Copy the pdfjs-dist web worker to public/ so dev mode can
 * serve it as a static file. Vite's /@fs/ transform hangs on
 * the 1.2 MB worker bundle; a static copy avoids that.
 * Skipped in production builds where Vite's ?url import
 * handles the worker with content hashing.
 */
const copyPdfjsWorker = (): Plugin => {
  let isDev = false;
  return {
    name: "copy-pdfjs-worker",
    configResolved(cfg) {
      isDev = cfg.command === "serve";
    },
    buildStart() {
      if (!isDev) {
        return;
      }
      const src = fileURLToPath(
        import.meta.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
      );
      const dest = resolve(import.meta.dirname, "public/pdf.worker.min.mjs");
      cpSync(src, dest, { force: true });
    },
  };
};

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    copyPdfjsWorker(),
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({
      include: /\.[jt]sx?$/,
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
  ],
});
