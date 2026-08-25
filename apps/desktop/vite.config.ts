import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const DESKTOP_ROOT = path.resolve(import.meta.dirname, "src/mainview");
const DESKTOP_VIEW_PORT = Number(
  process.env["STELLA_DESKTOP_VIEW_PORT"] ?? "5177",
);

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  root: DESKTOP_ROOT,
  build: {
    emptyOutDir: true,
    outDir: "../../dist",
    rolldownOptions: {
      input: {
        main: path.join(DESKTOP_ROOT, "index.html"),
        "takeover-dialog": path.join(DESKTOP_ROOT, "takeover-dialog.html"),
        "selfhost-connect-dialog": path.join(
          DESKTOP_ROOT,
          "selfhost-connect-dialog.html",
        ),
      },
    },
  },
  server: {
    port: DESKTOP_VIEW_PORT,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
