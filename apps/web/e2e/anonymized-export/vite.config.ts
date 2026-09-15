import path from "node:path";
import { defineConfig } from "vite";

const ROOT = import.meta.dirname;

export default defineConfig({
  root: ROOT,
  resolve: { alias: { "@": path.resolve(ROOT, "../../src") } },
  server: {
    host: "127.0.0.1",
    port: 4177,
    strictPort: true,
    fs: { allow: [path.resolve(ROOT, "../..")] },
  },
});
