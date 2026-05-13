import { defineConfig } from "drizzle-kit";

import { resolveDatabaseUrl } from "./src/db-url";

// Fallback keeps knip and CI happy when no DB env is set.
// drizzle-kit push/generate will fail fast on connection, not silently.
const url = resolveDatabaseUrl() ?? "postgresql://invalid";

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts", "./src/db/rls.ts"],
  dialect: "postgresql",
  dbCredentials: { url },
});
