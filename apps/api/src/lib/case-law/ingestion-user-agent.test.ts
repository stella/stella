import { expect, setDefaultTimeout, test } from "bun:test";
import nodeOs from "node:os";
import nodePath from "node:path";

/**
 * Ingestion adapters and record parsers import with no environment at all.
 *
 * Offline tools (bulk input publishers, scope assembly, parser checks) import
 * the shared adapter utilities only to hash and map records. When one module in
 * that graph reads `envBase`, the import dies on `Invalid environment variables`
 * before any work starts. This imports the shared utilities in a scrubbed
 * environment and fails on that message.
 *
 * `--env-file` pointed at an empty file keeps Bun from loading a developer's
 * `apps/api/.env`, which would otherwise supply the variables this proves are
 * unnecessary (see `db/migrate-environment.test.ts`).
 */

const EMPTY_ENV_FILE = nodePath.join(
  nodeOs.tmpdir(),
  "stella-ingestion-user-agent-empty.env",
);
const ENVIRONMENT_VALIDATION_MESSAGE = "Invalid environment variables";
const LOADED = "adapter utilities loaded";

// timeout: each case cold-starts a Bun subprocess that loads the adapter graph.
setDefaultTimeout(60_000);

const importInEmptyEnvironment = async (
  modulePath: string,
  environment: Record<string, string> = {},
) => {
  await Bun.write(EMPTY_ENV_FILE, "");
  const child = Bun.spawn({
    cmd: [
      "bun",
      `--env-file=${EMPTY_ENV_FILE}`,
      "--eval",
      `const module = await import(${JSON.stringify(modulePath)}); console.log(${JSON.stringify(LOADED)}); console.log(module.INGESTION_USER_AGENT ?? "");`,
    ],
    env: { PATH: process.env["PATH"] ?? "", ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stderr, stdout, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stderr, stdout: stdout.trim().split("\n"), exitCode };
};

test("the shared adapter utilities import without the API environment", async () => {
  const result = await importInEmptyEnvironment(
    nodePath.resolve(
      import.meta.dir,
      "../../handlers/case-law/ingestion/adapters/utils.ts",
    ),
  );

  expect(result.stderr).not.toContain(ENVIRONMENT_VALIDATION_MESSAGE);
  expect(result.exitCode).toBe(0);
  expect(result.stdout[0]).toBe(LOADED);
  expect(result.stdout[1]).toStartWith("stella-ingestion/");
});

test("an explicit user agent overrides the default, and an empty one does not", async () => {
  const modulePath = nodePath.join(import.meta.dir, "ingestion-user-agent.ts");

  const explicit = await importInEmptyEnvironment(modulePath, {
    INGESTION_USER_AGENT: "fork-ingestion/1.0 (+https://example.com/contact)",
  });
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout[1]).toBe(
    "fork-ingestion/1.0 (+https://example.com/contact)",
  );

  const empty = await importInEmptyEnvironment(modulePath, {
    INGESTION_USER_AGENT: "",
  });
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout[1]).toStartWith("stella-ingestion/");
});
