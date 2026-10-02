import { expect, test } from "bun:test";
import nodePath from "node:path";

const MIGRATE_ENTRYPOINT = nodePath.resolve(import.meta.dir, "migrate.ts");
// Nothing listens on port 1, so a migrator that connected would fail with a
// connection error instead of the configuration error.
const UNREACHABLE_DATABASE_URL =
  "postgres://migrate:migrate@127.0.0.1:1/unreachable";

test("migrate rejects a missing load-gate configuration before connecting", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", MIGRATE_ENTRYPOINT],
    {
      cwd: import.meta.dir,
      env: { DATABASE_URL: UNREACHABLE_DATABASE_URL },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("EbsConfigurationMissingError");
  expect(stderr).toContain("DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER");
  expect(stderr).toContain("DB_LOAD_GATE_EBS_SIGNAL=disabled");
  expect(stderr).not.toContain("ECONNREFUSED");
  expect(stdout).not.toContain("migrate.online_deferred");
});
