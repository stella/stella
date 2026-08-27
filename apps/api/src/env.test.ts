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

const bootApiEnvironment = (env: Record<string, string | undefined>) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { env } = await import(${JSON.stringify(envModuleUrl)}); console.log(String(Object.isFrozen(env)));`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

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

  test("rejects mock AI in a production-shaped runtime", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      NODE_ENV: "production",
      USE_MOCK_AI: "true",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "USE_MOCK_AI is only supported in local development and tests.",
    );
  });

  test("accepts Railway private-network service URLs in production", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      DATABASE_URL:
        "postgres://owner:password@postgres.railway.internal:5432/stella",
      NODE_ENV: "production",
      REDIS_URL: "redis://default:password@redis.railway.internal:6379",
      USE_MOCK_AI: "false",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true");
  });

  test("rejects a plaintext remote conversion endpoint in production", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      GOTENBERG_URL: "http://converter.example.com",
      NODE_ENV: "production",
      USE_MOCK_AI: "false",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("GOTENBERG_URL must use HTTPS");
  });

  test("rejects Microsoft's shared authorization endpoint as a tenant", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      MICROSOFT_AUTH_CLIENT_ID: "client-id",
      MICROSOFT_AUTH_CLIENT_SECRET: "client-secret",
      MICROSOFT_AUTH_TENANT_ID: "common",
      NODE_ENV: "production",
      USE_MOCK_AI: "false",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "MICROSOFT_AUTH_TENANT_ID must name one directory",
    );
  });

  test("rejects static credential placeholders for the env provider", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      S3_ACCESS_KEY_ID: " use-iam-role ",
      S3_CREDENTIALS_PROVIDER: "env",
      S3_SECRET_ACCESS_KEY: "USE-IAM-ROLE",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'S3_CREDENTIALS_PROVIDER="env" requires static S3 credentials.',
    );
  });

  test("rejects blank numeric backpressure settings", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: "   ",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK",
    );
  });

  test.each([
    {
      expected:
        "DATABASE_URL must enable TLS outside loopback or Railway private networking.",
      overrides: {
        DATABASE_URL:
          "postgres://owner:password@db.example.com:5432/stella?sslmode=disable",
      },
    },
    {
      expected:
        "S3_ENDPOINT must use HTTPS unless it targets a loopback address.",
      overrides: { S3_ENDPOINT: "http://storage.example.com" },
    },
    {
      expected:
        "REDIS_URL must use rediss:// unless it targets loopback or Railway private networking.",
      overrides: { REDIS_URL: "redis://cache.example.com:6379" },
    },
    {
      expected:
        "BETTER_AUTH_URL must use HTTPS unless it targets a loopback address.",
      overrides: { BETTER_AUTH_URL: "http://api.example.com" },
    },
    {
      expected:
        "FRONTEND_URL must use HTTPS unless it targets a loopback address.",
      overrides: { FRONTEND_URL: "http://workspace.example.com" },
    },
    {
      expected:
        "PUBLIC_URL must use HTTPS unless it targets a loopback address.",
      overrides: { PUBLIC_URL: "http://public-api.example.com" },
    },
  ])(
    "rejects plaintext production transport: $expected",
    ({ expected, overrides }) => {
      const result = bootApiEnvironment({
        ...baseEnv,
        ...overrides,
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(expected);
    },
  );
});
