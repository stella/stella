import { describe, expect, test } from "bun:test";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests) {
  describe.skip("review account provisioning against PostgreSQL", () => {
    test("requires the PostgreSQL suite", () => {});
  });
} else {
  test("review account provisioning against PostgreSQL", async () => {
    // Auth and environment owners cache configuration on first import. Keep
    // this account's configuration out of the other gated suites' process.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "test",
        "--preload",
        "./src/tests/setup-env.ts",
        `${import.meta.dir}/../tests/fixtures/review-account.db.fixture.ts`,
      ],
      env: {
        ...process.env,
        APP_REVIEW_ACCOUNT_EMAIL: `review-${Bun.randomUUIDv7()}@stella.dev`,
        APP_REVIEW_ORGANIZATION_ID: Bun.randomUUIDv7().replaceAll("-", ""),
        SELFHOST_LOCAL_PASSWORD_AUTH: "false",
        E2E_DISABLE_AUTH_RATE_LIMIT: "true",
        NODE_ENV: "development",
        STELLA_LOCAL_DEV: "1",
      },
      timeout: 100_000,
      killSignal: "SIGKILL",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(child.signalCode, `${stdout}\n${stderr}`).toBeNull();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 120_000);
}
