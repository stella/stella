import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

const monorepoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: __dirname,
  resolve: {
    alias: [
      {
        find: /^@stella\/ui\/(.*)/,
        replacement: path.join(monorepoRoot, "packages/ui/src/$1"),
      },
      {
        find: "@stella/ui",
        replacement: path.join(monorepoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: "@stella/folio",
        replacement: path.join(monorepoRoot, "packages/folio/src/index.ts"),
      },
      {
        find: /^@stella\/docx-utils(.*)/,
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
