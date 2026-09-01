import path from "node:path";
import { defineConfig } from "vite";

const ROOT = import.meta.dirname;

export default defineConfig({
  root: ROOT,
  server: {
    host: "127.0.0.1",
    port: 4176,
    strictPort: true,
    fs: { allow: [path.resolve(ROOT, "../..")] },
  },
});
