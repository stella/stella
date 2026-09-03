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

const spawnApiEnvironment = (
  env: Record<string, string | undefined>,
  script: string,
  // The repository .env would otherwise supply a DATABASE_URL, hiding the
  // database-component path these cases exist to exercise.
  ignoreEnvFile = false,
) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      ...(ignoreEnvFile ? ["--no-env-file"] : []),
      "-e",
      script,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

const FREEZE_SCRIPT = `const { env } = await import(${JSON.stringify(envModuleUrl)}); console.log(String(Object.isFrozen(env)));`;
const DATABASE_URL_SCRIPT = `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(env.DATABASE_URL);`;

const bootApiEnvironment = (env: Record<string, string | undefined>) =>
  spawnApiEnvironment(env, FREEZE_SCRIPT);

const bootDerivedDatabaseEnvironment = (
  env: Record<string, string | undefined>,
) => spawnApiEnvironment(env, FREEZE_SCRIPT, true);

const readDerivedDatabaseUrl = (env: Record<string, string | undefined>) => {
  const result = spawnApiEnvironment(env, DATABASE_URL_SCRIPT, true);

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

  test("accepts Microsoft's shared authorization endpoint for multi-tenant sign-in", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      MICROSOFT_AUTH_CLIENT_ID: "client-id",
      MICROSOFT_AUTH_CLIENT_SECRET: "client-secret",
      MICROSOFT_AUTH_TENANT_ID: "common",
      NODE_ENV: "production",
      USE_MOCK_AI: "false",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true");
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

  test("reads a provisioning placeholder in an optional credential as absent", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      S3_ACCESS_KEY_ID: "PLACEHOLDER_SET_ME",
      S3_CREDENTIALS_PROVIDER: "env",
      S3_SECRET_ACCESS_KEY: "UNCONFIGURED",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'S3_CREDENTIALS_PROVIDER="env" requires static S3 credentials.',
    );
  });

  test("refuses to boot when a required value holds a placeholder", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      S3_BUCKET: "PLACEHOLDER_SET_ME",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "S3_BUCKET must be set to a real value",
    );
  });

  const databaseComponents = {
    DB_HOST: "localhost",
    DB_NAME: "stella",
    DB_PASSWORD: "postgres",
    DB_PORT: "5432",
    DB_SSLMODE: "require",
    DB_USER: "postgres",
  } as const;
  const { DATABASE_URL: _databaseUrl, ...envWithoutDatabaseUrl } = baseEnv;

  test("refuses to assemble a database URL from a placeholder component", () => {
    const result = bootDerivedDatabaseEnvironment({
      ...envWithoutDatabaseUrl,
      ...databaseComponents,
      DB_PASSWORD: "PLACEHOLDER_SET_ME",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "DB_PASSWORD must be set to a real value",
    );
  });

  test("ignores placeholder components when DATABASE_URL is supplied", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      ...databaseComponents,
      DB_PASSWORD: "PLACEHOLDER_SET_ME",
      DB_USER: "UNCONFIGURED",
    });

    expect(result.stderr.toString()).not.toContain("placeholder");
    expect(result.exitCode).toBe(0);
  });

  test("defaults the SSL mode when the component is empty", () => {
    expect(
      readDerivedDatabaseUrl({
        ...envWithoutDatabaseUrl,
        ...databaseComponents,
        DB_SSLMODE: "",
      }),
    ).toBe(
      "postgres://postgres:postgres@localhost:5432/stella?sslmode=require",
    );
  });

  test("defaults the SSL mode when the component holds a placeholder", () => {
    expect(
      readDerivedDatabaseUrl({
        ...envWithoutDatabaseUrl,
        ...databaseComponents,
        DB_SSLMODE: "UNCONFIGURED",
      }),
    ).toBe(
      "postgres://postgres:postgres@localhost:5432/stella?sslmode=require",
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
