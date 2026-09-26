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
  CONTENT_ENCRYPTION_KEY: "a".repeat(64),
} as const;

const LOCAL_DEV_ENV = {
  NODE_ENV: "development",
  STELLA_LOCAL_DEV: "1",
} as const;

const envModuleUrl = new URL("env.ts", import.meta.url).href;
const repoRoot = new URL("../../..", import.meta.url).pathname;

// A developer's .env in the repository root would otherwise leak into these
// runtimes and decide their outcome.
const spawnApiEnvironment = (
  env: Record<string, string | undefined>,
  script: string,
) =>
  Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", script],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

const readEnvValue = (
  env: Record<string, string | undefined>,
  name: "EMAIL_PROVIDER" | "SELFHOST_LOCAL_PASSWORD_AUTH",
) => {
  const result = spawnApiEnvironment(
    env,
    `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(String(env.${name}));`,
  );

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

const readEnvProvider = (env: Record<string, string | undefined>) =>
  readEnvValue(env, "EMAIL_PROVIDER");

const readSelfhostLocalPasswordAuth = (
  env: Record<string, string | undefined>,
) => readEnvValue(env, "SELFHOST_LOCAL_PASSWORD_AUTH");

const FREEZE_SCRIPT = `const { env } = await import(${JSON.stringify(envModuleUrl)}); console.log(String(Object.isFrozen(env)));`;
const DATABASE_URL_SCRIPT = `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(env.DATABASE_URL);`;

const bootApiEnvironment = (env: Record<string, string | undefined>) =>
  spawnApiEnvironment(env, FREEZE_SCRIPT);

const readDerivedDatabaseUrl = (env: Record<string, string | undefined>) => {
  const result = spawnApiEnvironment(env, DATABASE_URL_SCRIPT);

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

  test("rejects the dev public-law connect command outside development", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      CONTENT_ENCRYPTION_KEY: "a".repeat(64),
      DEV_PUBLIC_LAW_CONNECT_COMMAND: "/usr/local/bin/connect",
      NODE_ENV: "production",
      USE_MOCK_AI: "false",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "DEV_PUBLIC_LAW_CONNECT_COMMAND is only supported in local development and tests.",
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
    const result = bootApiEnvironment({
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

describe("local development access", () => {
  test.each([
    { label: "NODE_ENV unset", overrides: {} },
    { label: "NODE_ENV=development", overrides: { NODE_ENV: "development" } },
    { label: "NODE_ENV=test", overrides: { NODE_ENV: "test" } },
  ])("stays strict without the runtime opt-in ($label)", ({ overrides }) => {
    const strict = bootApiEnvironment({ ...baseEnv, ...overrides });
    const mockAi = bootApiEnvironment({
      ...baseEnv,
      ...overrides,
      USE_MOCK_AI: "true",
    });
    const plaintextStorage = bootApiEnvironment({
      ...baseEnv,
      ...overrides,
      S3_ENDPOINT: "http://storage.example.com",
    });

    expect(strict.exitCode).toBe(0);
    expect(strict.stdout.toString().trim()).toBe("true");
    expect(mockAi.stderr.toString()).toContain(
      "USE_MOCK_AI is only supported in local development and tests.",
    );
    expect(plaintextStorage.stderr.toString()).toContain(
      "S3_ENDPOINT must use HTTPS unless it targets a loopback address.",
    );
  });

  test("relaxes local-only settings with the runtime opt-in", () => {
    const { CONTENT_ENCRYPTION_KEY: _key, ...withoutKey } = baseEnv;
    const result = bootApiEnvironment({
      ...withoutKey,
      ...LOCAL_DEV_ENV,
      S3_ENDPOINT: "http://storage.example.com",
      USE_MOCK_AI: "true",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("false");
  });

  test.each(["production", "staging", ""])(
    "refuses the opt-in with NODE_ENV=%p",
    (nodeEnv) => {
      const result = bootApiEnvironment({
        ...baseEnv,
        NODE_ENV: nodeEnv,
        STELLA_LOCAL_DEV: "1",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "STELLA_LOCAL_DEV=1 requires NODE_ENV=development or test",
      );
    },
  );

  test("refuses an opt-in value other than 1", () => {
    const result = bootApiEnvironment({
      ...baseEnv,
      NODE_ENV: "development",
      STELLA_LOCAL_DEV: "true",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'STELLA_LOCAL_DEV accepts only "1".',
    );
  });

  test("keeps the auth rate-limit bypass to NODE_ENV=development with the opt-in", () => {
    const withoutOptIn = bootApiEnvironment({
      ...baseEnv,
      E2E_DISABLE_AUTH_RATE_LIMIT: "true",
      NODE_ENV: "development",
    });
    const testProcess = bootApiEnvironment({
      ...baseEnv,
      E2E_DISABLE_AUTH_RATE_LIMIT: "true",
      NODE_ENV: "test",
      STELLA_LOCAL_DEV: "1",
    });
    const development = bootApiEnvironment({
      ...baseEnv,
      ...LOCAL_DEV_ENV,
      E2E_DISABLE_AUTH_RATE_LIMIT: "true",
    });

    for (const refused of [withoutOptIn, testProcess]) {
      expect(refused.stderr.toString()).toContain(
        "E2E_DISABLE_AUTH_RATE_LIMIT is test-only",
      );
    }
    expect(development.exitCode, development.stderr.toString()).toBe(0);
  });
});
