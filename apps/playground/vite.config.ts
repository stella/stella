import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const playgroundRoot = import.meta.dirname;
const monorepoRoot = path.resolve(playgroundRoot, "../..");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: playgroundRoot,
  resolve: {
    alias: [
      {
        find: /^@stll\/ui\/(.*)/,
        replacement: path.join(monorepoRoot, "packages/ui/src/$1"),
      },
      {
        find: "@stll/ui",
        replacement: path.join(monorepoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: "@stll/folio",
        replacement: path.join(monorepoRoot, "packages/folio/src/index.ts"),
      },
      {
        find: /^@stll\/docx-utils(.*)/,
        replacement: path.join(monorepoRoot, "packages/docx-utils/src$1"),
      },
    ],
  },
  server: {
    port: 4200,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: "dist",
  },
});
