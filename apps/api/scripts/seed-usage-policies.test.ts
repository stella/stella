import { expect, test } from "bun:test";

const runSeed = async (seeds: string) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL("seed-usage-policies.ts", import.meta.url).pathname,
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
  return { exitCode, stdout, stderr };
};

test("empty usage policy configuration exits without database access", async () => {
  const result = await runSeed("[]");
  expect(result).toEqual({
    exitCode: 0,
    stdout: "usage policies: seeded=0 hidden=0\n",
    stderr: "",
  });
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
      stdout: "",
      stderr:
        "Usage policy seed failed; check configuration and database access.\n",
    });
  },
);
