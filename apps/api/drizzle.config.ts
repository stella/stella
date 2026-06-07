import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveDatabaseUrl } from "./src/db-url";

// Load .env file manually when running under Node (which lacks Bun's auto env loading)
if (typeof process.loadEnvFile === "function") {
  const envPath = resolve(import.meta.dirname, ".env");
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Ignore
    }
  }
}

// Fallback keeps knip and CI happy when no DB env is set.
// drizzle-kit push/generate will fail fast on connection, not silently.
const url = resolveDatabaseUrl() ?? "postgresql://invalid";

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts", "./src/db/rls.ts"],
  dialect: "postgresql",
  dbCredentials: { url },
});
