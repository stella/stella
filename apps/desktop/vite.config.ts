import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DESKTOP_VIEW_PORT = Number(
  process.env["STELLA_DESKTOP_VIEW_PORT"] ?? "5177",
);

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  root: "src/mainview",
  build: {
    emptyOutDir: true,
    outDir: "../../dist",
    rollupOptions: {
      input: {
        main: "src/mainview/index.html",
        "takeover-dialog": "src/mainview/takeover-dialog.html",
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
