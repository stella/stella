import { defineConfig } from "drizzle-kit";

// Fallback keeps knip and CI happy when DATABASE_URL is unset.
// drizzle-kit push/generate will fail fast on connection, not silently.
const url = process.env.DATABASE_URL ?? "postgresql://invalid";

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts", "./src/db/rls.ts"],
  dialect: "postgresql",
  dbCredentials: { url },
});
