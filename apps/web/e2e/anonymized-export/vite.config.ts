import path from "node:path";
import { defineConfig } from "vite";

const ROOT = import.meta.dirname;

export default defineConfig({
  root: ROOT,
  // CI keeps the application server running while this fixture starts.
  // Separate optimizer caches prevent either server invalidating the other.
  cacheDir: path.resolve(ROOT, "../../node_modules/.vite-anonymized-export"),
  resolve: { alias: { "@": path.resolve(ROOT, "../../src") } },
  server: {
    host: "127.0.0.1",
    port: 4177,
    strictPort: true,
    fs: { allow: [path.resolve(ROOT, "../..")] },
  },
});
