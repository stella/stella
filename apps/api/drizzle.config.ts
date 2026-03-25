import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts", "./src/db/rls.ts"],
  dialect: "postgresql",
  dbCredentials: { url },
});
