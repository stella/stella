import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { resolveDesktopViewPort } from "./src/dev-config";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  root: "src/mainview",
  build: {
    emptyOutDir: true,
    outDir: "../../dist",
  },
  server: {
    port: resolveDesktopViewPort(process.env),
    strictPort: true,
  },
});
