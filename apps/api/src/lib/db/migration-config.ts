import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DRIZZLE_MIGRATIONS_SCHEMA = "drizzle";
export const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
export const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");

export const assertMigrationsDirectoryPresent = (): void => {
  if (existsSync(MIGRATIONS_DIR)) {
    return;
  }

  throw new Error(
    `[startup] No migration files at ${MIGRATIONS_DIR}; refusing to start. ` +
      "The runtime image must include apps/api/drizzle/.",
  );
};
