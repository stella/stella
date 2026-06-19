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
        find: /^@stll\/ui\/(?<rest>.*)/u,
        replacement: path.join(monorepoRoot, "packages/ui/src/$<rest>"),
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
        find: /^@stll\/docx-utils(?<rest>.*)/u,
        replacement: path.join(monorepoRoot, "packages/docx-utils/src$<rest>"),
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
