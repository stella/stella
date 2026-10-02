import { panic } from "better-result";
import { SQL } from "bun";
import nodePath from "node:path";

// Relative imports: this entrypoint also ships as a loose file without tsconfig.
import { resolveDatabaseUrl } from "../db-url";
import { runMigrationsUntilSettled } from "./migration-runner";

const url = resolveDatabaseUrl();
if (!url) {
  panic(
    "migrate: no database connection; set DATABASE_URL or the DB_* components",
  );
}

const client = new SQL({ url, max: 1 });
// The loose source and single-file bundle both resolve drizzle from this file.
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
const connection = await client.reserve();
try {
  const result = await runMigrationsUntilSettled({
    connection,
    migrationsFolder,
  });
  if (result.status === "applied") {
    // oxlint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface
    console.info("[migrate] migrations applied");
  }
} catch (error) {
  // oxlint-disable-next-line no-console -- migrate CLI entrypoint; surface the failure to the deploy log
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
} finally {
  connection.release();
  await client.end();
}
