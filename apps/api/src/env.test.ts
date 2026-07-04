import { describe, expect, test } from "bun:test";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stella-test",
  S3_REGION: "us-east-1",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3001",
  FRONTEND_URL: "http://localhost:3000",
  GOTENBERG_URL: "http://localhost:3002",
  GOTENBERG_USERNAME: "test",
  GOTENBERG_PASSWORD: "test",
} as const;

const envModuleUrl = new URL("env.ts", import.meta.url).href;
const repoRoot = new URL("../../..", import.meta.url).pathname;

const readEnvProvider = (env: Record<string, string | undefined>) => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(String(env.EMAIL_PROVIDER));`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

const readSelfhostLocalPasswordAuth = (
  env: Record<string, string | undefined>,
) => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(String(env.SELFHOST_LOCAL_PASSWORD_AUTH));`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

describe("API environment", () => {
  test("infers SMTP provider from complete SMTP settings", () => {
    expect(
      readEnvProvider({
        ...baseEnv,
        SMTP_HOST: "localhost",
        SMTP_PORT: "1025",
        TRANSACTIONAL_EMAIL_FROM: "test@example.com",
      }),
    ).toBe("smtp");
  });

  test("allows transactional email to be unconfigured", () => {
    expect(readEnvProvider(baseEnv)).toBe("undefined");
  });

  test("allows local password auth after bootstrap token removal", () => {
    expect(
      readSelfhostLocalPasswordAuth({
        ...baseEnv,
        SELFHOST_LOCAL_PASSWORD_AUTH: "true",
      }),
    ).toBe("true");
  });
});
