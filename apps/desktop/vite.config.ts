import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

import {
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_OPTIONS,
} from "@stll/scripts/src/react-compiler-options";

const DESKTOP_ROOT = path.resolve(import.meta.dirname, "src/mainview");
const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/u;
const DESKTOP_VIEW_PORT = Number(
  process.env["STELLA_DESKTOP_VIEW_PORT"] ?? "5177",
);

export default defineConfig({
  base: "./",
  plugins: [
    tailwindcss(),
    // The same React Compiler build as the web app, so the shared components
    // run with the memoization they are written for.
    react({
      compiler: REACT_COMPILER_OPTIONS,
      exclude: REACT_COMPILER_EXCLUDE,
    }),
  ],
  root: DESKTOP_ROOT,
  build: {
    // The windows' CSP takes fonts only from the app itself (font-src falls
    // back to `default-src 'self'`), so a font is never inlined as a data:
    // URI, however small (KaTeX ships some under the inline limit). Images
    // may still be (`img-src 'self' data:`).
    assetsInlineLimit: (file) => (FONT_FILE.test(file) ? false : undefined),
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
        "pdf-sign-dialog": path.join(DESKTOP_ROOT, "pdf-sign-dialog.html"),
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
