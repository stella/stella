import { panic } from "better-result";
import { realpathSync } from "node:fs";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import { withSharedTestPostgresConnection } from "@stll/scripts/src/shared-test-postgres";

import { runMigrations } from "../src/db/migration-runner";
import { sharedTestTemplateMigrations } from "./shared-test-template-migrations";

const [folder] = process.argv.slice(2);
const url = process.env["DATABASE_URL"];
if (!folder || !url) {
  panic("Shared template migration folder and database URL required");
}

await runScriptWithErrorOutput(
  async () =>
    await withSharedTestPostgresConnection(url, async (connection) => {
      await runMigrations({
        connection,
        databaseUrl: url,
        migrationsFolder: realpathSync(folder),
        readMigrations: sharedTestTemplateMigrations,
        ebs: { type: "disabled" },
        // Online repairs belong to the worker revision, after its dependencies
        // are installed; canonical runtime code must never alter an older schema.
        runOnline: () => ({ type: "complete" }),
      });
    }),
);
