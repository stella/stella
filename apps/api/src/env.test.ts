import { describe, expect, test } from "bun:test";

import { DEMO_ACCOUNT_OTP_WARNING_EVENT } from "@/api/lib/auth/demo-account-otp-policy";

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
  test("configured sign-in codes preserve readiness and bounded warnings", () => {
    const otpModuleUrl = new URL("lib/demo-account-otp.ts", import.meta.url)
      .href;
    const routesModuleUrl = new URL(
      "handlers/health/routes.ts",
      import.meta.url,
    ).href;
    const script = `const { getDemoAccountOtpOverride } = await import(${JSON.stringify(otpModuleUrl)});
      const { createHealthRoute } = await import(${JSON.stringify(routesModuleUrl)});
      const codes = [" Account@Example.Test ", "standard@example.test", "standard@example.test", "account@example.test"].map(email => getDemoAccountOtpOverride({ email, type: "sign-in" }) ?? null);
      const route = createHealthRoute({ probeReadiness: async () => ({ status: "ready" }) });
      const response = await route.handle(new Request("http://localhost/ready"));
      console.log(JSON.stringify({ status: response.status, codes }));`;
    const result = spawnApiEnvironment(
      {
        ...baseEnv,
        DEMO_ACCOUNT_EMAIL: " Account@Example.Test ",
        DEMO_ACCOUNT_OTP: "654321",
      },
      script,
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const response = result.stdout.toString().trim().split("\n").at(-1);
    expect(response).toBeDefined();
    if (response === undefined) {
      throw new Error("Response must be present");
    }
    expect(JSON.parse(response)).toEqual({
      status: 200,
      codes: ["654321", null, null, "654321"],
    });
    const warnings = result.stderr
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.includes(DEMO_ACCOUNT_OTP_WARNING_EVENT));
    expect(warnings).toHaveLength(1);
    for (const warning of warnings) {
      expect(JSON.parse(warning)).toMatchObject({
        severity: "WARN",
        message: DEMO_ACCOUNT_OTP_WARNING_EVENT,
      });
      expect(warning).not.toContain("example.test");
      expect(warning).not.toContain("654321");
    }
  });

  test("uses configured credentials in strict mode and examples in local development", () => {
    const example = {
      ...baseEnv,
      BETTER_AUTH_SECRET: "your-secret-at-least-32-chars-long",
    };
    const strict = bootApiEnvironment(example);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.stderr.toString()).toContain(
      "BETTER_AUTH_SECRET must use configured values",
    );
    expect(strict.stderr.toString()).not.toContain(example.BETTER_AUTH_SECRET);
    const local = bootApiEnvironment({ ...example, ...LOCAL_DEV_ENV });
    expect(local.exitCode, local.stderr.toString()).toBe(0);
  });

  test("preserves structured stdout when loading the environment", () => {
    const result = spawnApiEnvironment(
      baseEnv,
      `import { env } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(JSON.stringify({ redisUrl: env.REDIS_URL }));`,
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      JSON.stringify({ redisUrl: baseEnv.REDIS_URL }),
    );
  });

  test("service budgets cannot be enabled without action admission", () => {
    for (const admission of [undefined, "false", "true"]) {
      const result = bootApiEnvironment({
        ...baseEnv,
        FEATURE_ORG_SERVICE_BUDGETS: "true",
        FEATURE_ACTION_ADMISSION: admission,
      });
      if (admission === "true") {
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      } else {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "FEATURE_ORG_SERVICE_BUDGETS requires FEATURE_ACTION_ADMISSION",
        );
      }
    }
  });

  test("configured access is off by default and requires its enforcement settings", () => {
    const defaults = spawnApiEnvironment(
      baseEnv,
      `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(String(env.FEATURE_CONFIGURED_ACCESS));`,
    );
    expect(defaults.exitCode, defaults.stderr.toString()).toBe(0);
    expect(defaults.stdout.toString().trim()).toBe("false");
    const configured = {
      ...baseEnv,
      FEATURE_CONFIGURED_ACCESS: "true",
      FEATURE_ORG_ACCESS_STATE: "true",
      FEATURE_ORG_SERVICE_BUDGETS: "true",
      FEATURE_ACTION_ADMISSION: "true",
      FEATURE_USAGE: "true",
      PAYMENT_RETRY_WINDOW_MS: "13000",
      ORG_EVALUATION_PERIOD_DAYS: "11",
    };
    expect(bootApiEnvironment(configured).exitCode).toBe(0);
    for (const setting of [
      "FEATURE_ORG_ACCESS_STATE",
      "FEATURE_ORG_SERVICE_BUDGETS",
      "FEATURE_USAGE",
      "PAYMENT_RETRY_WINDOW_MS",
    ] as const) {
      const result = bootApiEnvironment({
        ...configured,
        [setting]: undefined,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "FEATURE_CONFIGURED_ACCESS requires",
      );
    }
    for (const duration of ["0", "-1", "1.5", "NaN"]) {
      expect(
        bootApiEnvironment({ ...configured, PAYMENT_RETRY_WINDOW_MS: duration })
          .exitCode,
      ).not.toBe(0);
    }
  });

  test("the free tier refuses to boot alongside usage enforcement", () => {
    const freeTier = {
      ...baseEnv,
      FEATURE_FREE_TIER: "true",
      FEATURE_ORG_ACCESS_STATE: "true",
      FEATURE_ORG_SERVICE_BUDGETS: "true",
      FEATURE_ACTION_ADMISSION: "true",
      ORG_EVALUATION_PERIOD_DAYS: "11",
    };
    const booted = bootApiEnvironment(freeTier);
    expect(booted.exitCode, booted.stderr.toString()).toBe(0);
    const enforced = bootApiEnvironment({
      ...freeTier,
      USAGE_ENFORCEMENT_ENABLED: "true",
    });
    expect(enforced.exitCode).not.toBe(0);
    expect(enforced.stderr.toString()).toContain(
      "FEATURE_FREE_TIER requires USAGE_ENFORCEMENT_ENABLED to be off.",
    );
  });

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
