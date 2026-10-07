import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

const runSeed = async (seeds: string, extraArgs: readonly string[] = []) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "policy-cli-"));
  const resultsPath = nodePath.join(dir, "results.jsonl");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL("seed-usage-policies.ts", import.meta.url).pathname,
      "--results",
      resultsPath,
      ...extraArgs,
    ],
    {
      env: {
        NODE_ENV: "test",
        STELLA_LOCAL_DEV: "1",
        DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
        REDIS_URL: "redis://localhost:6379",
        S3_ENDPOINT: "http://localhost:9000",
        S3_BUCKET: "stella",
        S3_REGION: "us-east-1",
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "http://localhost:3001",
        FRONTEND_URL: "http://localhost:3000",
        EMAIL_PROVIDER: "smtp",
        SMTP_HOST: "localhost",
        SMTP_PORT: "1025",
        TRANSACTIONAL_EMAIL_FROM: "test@example.com",
        GOTENBERG_URL: "http://localhost:3002",
        GOTENBERG_USERNAME: "test",
        GOTENBERG_PASSWORD: "test",
        STELLA_USAGE_POLICY_SEEDS: seeds,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const report = readFileSync(resultsPath, "utf-8");
  rmSync(dir, { recursive: true });
  return { exitCode, stdout, stderr, report };
};

// Empty seeds still retire an active free policy, so they need the database.
test("empty usage policy configuration fails when the database is unreachable", async () => {
  const result = await runSeed("[]");
  expect(result).toEqual({
    exitCode: 1,
    stdout: expect.stringContaining("```jsonl\n\n```"),
    report: "",
    stderr: expect.stringContaining(
      "Usage policy seed failed; check configuration, results path and database access.\n",
    ),
  });
  expect(result.stdout).not.toContain("usage policies: seeded=");
});

test.each([
  "invalid JSON",
  JSON.stringify([
    { key: "sample-policy", displayName: "Sample", monthlyUsageUnits: -1 },
  ]),
  JSON.stringify([
    {
      key: "sample-policy",
      displayName: "Sample",
      monthlyUsageUnits: 1,
      serviceActionsPerPeriod: 0,
    },
  ]),
])(
  "invalid usage policy configuration fails without printing values: %s",
  async (seeds) => {
    const result = await runSeed(seeds);
    expect(result).toEqual({
      exitCode: 1,
      stdout: expect.stringContaining("```jsonl\n\n```"),
      report: "",
      stderr:
        "Usage policy seed failed; check configuration, results path and database access.\n",
    });
  },
);

test.each([
  { args: [], mode: "apply" },
  { args: ["--dry-run"], mode: "dry_run" },
])(
  "database failure writes a redacted failed row and exits non-zero ($mode)",
  async ({ args, mode }) => {
    const result = await runSeed(
      JSON.stringify([
        {
          key: "sample-policy",
          displayName: "Private display",
          monthlyUsageUnits: 1,
          hostedPolicyRef: "private-ref",
        },
      ]),
      args,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.report)).toEqual({
      policyKey: "sample-policy",
      mode,
      outcome: "failed",
      reason: expect.any(String),
    });
    expect(result.stdout).toContain(result.report.trim());
    expect(`${result.stdout}${result.stderr}${result.report}`).not.toContain(
      "private-ref",
    );
    expect(`${result.stdout}${result.stderr}${result.report}`).not.toContain(
      "Private display",
    );
  },
);
