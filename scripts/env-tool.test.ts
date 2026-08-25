import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  ENV_CATALOG,
  ENV_EXPOSURE,
  ENV_OWNER,
  ENV_REQUIREMENT,
  requirementFor,
  WEB_ENV_SCHEMA,
} from "./env-catalog";
import {
  doctorEnvFileNames,
  findEnvUsages,
  findWebBuildArgGaps,
  formatEnvIssue,
  formatEnvValue,
  formatWebBuildArgGap,
  isIgnoredAuditPath,
  normalizeEmptyEnvironment,
  parseEnvLayers,
  parseEnvText,
  parseWebBuildContract,
  renderApiEnvExample,
  renderCollabEnvExample,
  renderWebBuildContract,
  renderWebEnvExample,
  resolveDoctorMode,
  resolveDoctorProcessEnvironment,
  validateDoctorEnvironment,
} from "./env-tool";

describe("generated environment examples", () => {
  test("contain every documented schema entry exactly once", () => {
    const examples = {
      api: renderApiEnvExample(),
      collab: renderCollabEnvExample(),
      web: renderWebEnvExample(),
    };

    for (const entry of ENV_CATALOG.filter(({ documented }) => documented)) {
      let example = examples.api;
      if (entry.owner === ENV_OWNER.web) {
        example = examples.web;
      } else if (entry.owner === ENV_OWNER.collab) {
        example = examples.collab;
      }
      const matches = example.match(new RegExp(`^#? ?${entry.name}=`, "gmu"));
      expect(matches).toHaveLength(1);
    }
  });

  test("groups component database settings in the database section", () => {
    const example = renderApiEnvExample();
    const databaseSection = example.slice(
      example.indexOf("# --- Database"),
      example.indexOf("# --- Storage and legal search"),
    );
    for (const name of [
      "DB_HOST",
      "DB_NAME",
      "DB_PASSWORD",
      "DB_PORT",
      "DB_SSLMODE",
      "DB_USER",
    ]) {
      expect(databaseSection).toContain(name);
    }
  });

  test("classifies every browser variable as public", () => {
    const webEntries = ENV_CATALOG.filter(
      ({ owner }) => owner === ENV_OWNER.web,
    );
    expect(
      webEntries.every(({ exposure }) => exposure === ENV_EXPOSURE.public),
    ).toBe(true);
  });

  test("derives requirements without executing schema transforms", () => {
    let transformExecuted = false;
    const schema = v.pipe(
      v.optional(v.string()),
      v.transform((value) => {
        transformExecuted = true;
        return value;
      }),
    );

    expect(requirementFor(schema)).toBe(ENV_REQUIREMENT.optional);
    expect(transformExecuted).toBe(false);
  });

  test("preserves conditional requirements from runtime invariants", () => {
    const sesRegion = ENV_CATALOG.find(({ name }) => name === "SES_REGION");
    expect(sesRegion?.requirement).toBe(ENV_REQUIREMENT.conditional);
    expect(sesRegion?.requirementNote).toBe("EMAIL_PROVIDER is ses");
    expect(renderApiEnvExample()).toContain(
      "Conditionally required when EMAIL_PROVIDER is ses.",
    );
  });
});

describe("environment file parsing", () => {
  test("matches Bun comments, quoting, and variable expansion", () => {
    expect(
      parseEnvText(
        [
          'ACTIVE="value # preserved"',
          "# SECRET=hidden",
          "export EMPTY=''",
          "SMTP_PORT=1025 # local relay",
          "PORT_PREFIX=54",
          `DB_PORT=\${PORT_PREFIX}32`,
          "AMBIENT_PORT=$PGPORT",
          String.raw`LITERAL=\$PGPORT`,
          `DEFAULT_PORT=\${MISSING_PORT:-5432}`,
          "EMPTY_VALUE=",
          `EMPTY_DEFAULT=\${EMPTY_VALUE:-5433}`,
          `SET_DEFAULT=\${PGPORT:-5432}`,
        ].join("\n"),
        { PGPORT: "6432" },
      ),
    ).toEqual({
      ACTIVE: "value # preserved",
      AMBIENT_PORT: "6432",
      DB_PORT: "5432",
      DEFAULT_PORT: "5432",
      EMPTY: "",
      EMPTY_DEFAULT: "",
      EMPTY_VALUE: "",
      LITERAL: "$PGPORT",
      PORT_PREFIX: "54",
      SET_DEFAULT: "6432",
      SMTP_PORT: "1025",
    });
  });

  test("matches Bun nested fallback expansion", () => {
    expect(
      parseEnvText(`DB_PORT=\${MISSING_PORT:-\${PGPORT:-5432}}`, {
        PGPORT: "6432",
      }),
    ).toEqual({ DB_PORT: "6432" });
  });

  test("matches Bun consecutive-dollar expansion", () => {
    const dollars = String.fromCodePoint(36);
    expect(
      parseEnvText(
        [
          "VALUE=resolved",
          `RUN=${dollars.repeat(32)}`,
          `PREFIX=${dollars.repeat(3)}VALUE`,
          `SUFFIX=${dollars}VALUE${dollars.repeat(4)}`,
          String.raw`ESCAPED=\$$$VALUE`,
        ].join("\n"),
        {},
      ),
    ).toEqual({
      ESCAPED: "$$resolved",
      PREFIX: "$$resolved",
      RUN: dollars.repeat(32),
      SUFFIX: `resolved${dollars.repeat(4)}`,
      VALUE: "resolved",
    });
  });

  test("delegates punctuation expansion to Bun", () => {
    expect(
      parseEnvText(`SECRET=${`${String.fromCodePoint(36)}-`.repeat(16)}`, {}),
    ).toEqual({ SECRET: `${String.fromCodePoint(36)}-`.repeat(16) });
  });

  test("matches runtime dotenv precedence and final-value expansion", () => {
    expect(doctorEnvFileNames({ app: "api", mode: "production" })).toEqual([
      ".env",
      ".env.production",
      ".env.local",
      ".env.production.local",
    ]);
    expect(doctorEnvFileNames({ app: "web", mode: "production" })).toEqual([
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]);
    expect(doctorEnvFileNames({ app: "api", mode: undefined })).toEqual([
      ".env",
      ".env.local",
    ]);
    expect(
      resolveDoctorMode({
        app: "web",
        nodeEnv: undefined,
        requestedMode: undefined,
      }),
    ).toBe("development");
    expect(
      resolveDoctorMode({
        app: "web",
        nodeEnv: "production",
        requestedMode: undefined,
      }),
    ).toBe("production");
    expect(
      resolveDoctorMode({
        app: "web",
        nodeEnv: "production",
        requestedMode: "test",
      }),
    ).toBe("test");
    expect(
      parseEnvLayers(
        [
          "VALUE=base\nFROM_BASE=$VALUE",
          "VALUE=mode\nFROM_MODE=$VALUE",
          "VALUE=local\nFROM_LOCAL=$VALUE",
          "VALUE=mode-local",
        ],
        {},
      ),
    ).toEqual({
      FROM_BASE: "mode-local",
      FROM_LOCAL: "mode-local",
      FROM_MODE: "mode-local",
      VALUE: "mode-local",
    });
    const doctorProcessEnvironment = resolveDoctorProcessEnvironment({
      environment: { NODE_ENV: "development" },
      mode: "production",
    });
    expect(
      parseEnvText("EXPANDED_MODE=$NODE_ENV", doctorProcessEnvironment),
    ).toEqual({ EXPANDED_MODE: "production" });
  });
});

describe("environment doctor output", () => {
  const validApiInput = () => parseEnvText(renderApiEnvExample(), {});

  test("never renders cataloged secret values", () => {
    const secretEntry = ENV_CATALOG.find(
      ({ exposure }) => exposure === ENV_EXPOSURE.secret,
    );
    expect(secretEntry).toBeDefined();
    if (!secretEntry) {
      return;
    }
    expect(formatEnvValue(secretEntry, "do-not-print-this")).toBe("<redacted>");
  });

  test("does not echo invalid non-public values in validation errors", () => {
    const secret = "actual-secret-value";
    for (const key of [
      "CORPUS_INDEX_ENDPOINT",
      "DATABASE_URL",
      "UNKNOWN_KEY",
    ]) {
      const result = v.safeParse(
        v.object({ [key]: v.pipe(v.string(), v.url()) }),
        { [key]: secret },
      );
      expect(result.success).toBe(false);
      if (result.success) {
        continue;
      }
      const issue = result.issues.at(0);
      expect(issue).toBeDefined();
      if (!issue) {
        continue;
      }
      expect(formatEnvIssue(issue)).not.toContain(secret);
    }
  });

  test("normalizes empty schema values after database URL resolution", () => {
    expect(
      normalizeEmptyEnvironment({
        DB_PASSWORD: "",
        DB_SSLMODE: "",
        EMAIL_PROVIDER: "",
      }),
    ).toEqual({
      DB_PASSWORD: "",
      DB_SSLMODE: "",
      EMAIL_PROVIDER: undefined,
    });
  });

  test("accepts database component settings when DATABASE_URL is absent", () => {
    const input = validApiInput();
    delete input["DATABASE_URL"];
    Object.assign(input, {
      DB_HOST: "localhost",
      DB_NAME: "stella",
      DB_PASSWORD: "",
      DB_PORT: "5432",
      DB_SSLMODE: "require",
      DB_USER: "postgres",
    });

    const result = validateDoctorEnvironment({ app: "api", input });
    expect(result.status).toBe("valid");
    expect(result.values["DATABASE_URL"]).toBe(
      "postgres://postgres:@localhost:5432/stella?sslmode=require",
    );
  });

  test("rejects an empty database SSL mode like API startup", () => {
    const input = validApiInput();
    delete input["DATABASE_URL"];
    Object.assign(input, {
      DB_HOST: "localhost",
      DB_NAME: "stella",
      DB_PASSWORD: "",
      DB_PORT: "5432",
      DB_SSLMODE: "",
      DB_USER: "postgres",
    });

    const result = validateDoctorEnvironment({ app: "api", input });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "DATABASE_URL: invalid database component settings.",
      );
    }
  });

  test("rejects a non-PostgreSQL case-law database URL", () => {
    const result = validateDoctorEnvironment({
      app: "api",
      input: {
        ...validApiInput(),
        PUBLIC_LAW_DATABASE_URL:
          "https://db.example.com/stella?sslmode=require",
      },
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "PUBLIC_LAW_DATABASE_URL: invalid secret value.",
      );
    }
  });

  test("keeps v0.7.22 and public-law credentials distinct during rollout", () => {
    const legacyUrl =
      "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require";
    const currentUrl =
      "postgres://public_law_reader:password@db.example.com:5432/stella?sslmode=require";
    const result = validateDoctorEnvironment({
      app: "api",
      input: {
        ...validApiInput(),
        CASE_LAW_DATABASE_POOL_MAX: "3",
        CASE_LAW_DATABASE_URL: legacyUrl,
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://quickwit-search.example.com",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
        PUBLIC_LAW_DATABASE_POOL_MAX: "4",
        PUBLIC_LAW_DATABASE_URL: currentUrl,
      },
    });

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.values["CASE_LAW_DATABASE_POOL_MAX"]).toBe(3);
      expect(result.values["CASE_LAW_DATABASE_URL"]).toBe(legacyUrl);
      expect(result.values["PUBLIC_LAW_DATABASE_POOL_MAX"]).toBe(4);
      expect(result.values["PUBLIC_LAW_DATABASE_URL"]).toBe(currentUrl);
    }
  });

  test("rejects a legacy-only shared-corpus configuration", () => {
    const result = validateDoctorEnvironment({
      app: "api",
      input: {
        ...validApiInput(),
        CASE_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://quickwit-search.example.com",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
      },
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "CASE_LAW_DATABASE_URL is a v0.7.22 rollback input; configure PUBLIC_LAW_DATABASE_URL for the current release.",
      );
    }
  });

  test.each([
    {
      expected:
        "MICROSOFT_AUTH_TENANT_ID is required when Microsoft OAuth is configured.",
      overrides: { MICROSOFT_AUTH_CLIENT_ID: "client-id" },
    },
    {
      expected:
        "Serving legislation_v1 on q08 requires CORPUS_INDEX_SEARCH_ENDPOINT or CORPUS_INDEX_ENDPOINT.",
      overrides: { LEGAL_SEARCH_PROVIDER: "corpus-index" },
    },
    {
      expected:
        "Serving case_law_v5 on q09 requires CORPUS_INDEX_Q09_SEARCH_ENDPOINT or CORPUS_INDEX_Q09_ENDPOINT.",
      overrides: {
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://quickwit-08.example.com",
        LEGAL_SEARCH_INDEX_GENERATION: "case_law_v5",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
      },
    },
    // Removed together with the invariant, in the PR that makes a corpus
    // cursor carry the dictionary version it was built against.
    {
      expected:
        'QUERY_EXPANSION_MODE="on" requires dictionary-version-carrying cursors; not yet implemented — use "shadow".',
      overrides: { QUERY_EXPANSION_MODE: "on" },
    },
    {
      expected:
        "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.",
      overrides: { NODE_ENV: "production" },
    },
    {
      expected: "USE_MOCK_AI is only supported in local development and tests.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        USE_MOCK_AI: "true",
      },
    },
    {
      expected: 'S3_CREDENTIALS_PROVIDER="env" requires static S3 credentials.',
      overrides: {
        S3_ACCESS_KEY_ID: "",
        S3_CREDENTIALS_PROVIDER: "env",
        S3_SECRET_ACCESS_KEY: "",
      },
    },
    {
      expected: 'S3_CREDENTIALS_PROVIDER="env" requires static S3 credentials.',
      overrides: {
        S3_ACCESS_KEY_ID: " use-iam-role ",
        S3_CREDENTIALS_PROVIDER: "env",
        S3_SECRET_ACCESS_KEY: "USE-IAM-ROLE",
      },
    },
    {
      expected:
        "DATABASE_URL must enable TLS outside loopback or Railway private networking.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        DATABASE_URL:
          "postgres://owner:password@db.example.com:5432/stella?sslmode=disable",
        NODE_ENV: "production",
      },
    },
    {
      expected:
        "PUBLIC_LAW_DATABASE_URL must enable TLS outside loopback or Railway private networking.",
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=disable",
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "staging",
      },
    },
    {
      expected:
        "Public-law database URLs are only supported in local development.",
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "staging",
      },
    },
    {
      expected:
        "CORPUS_INDEX_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address.",
      overrides: {
        CORPUS_INDEX_SEARCH_ENDPOINT: "http://search.example.com",
      },
    },
    {
      expected:
        "CORPUS_INDEX_SEARCH_ENDPOINT is only supported in local development.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://search.example.com",
        NODE_ENV: "staging",
      },
    },
    {
      expected:
        'Public-law database URLs require LEGAL_SEARCH_PROVIDER="corpus-index".',
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
      },
    },
    {
      expected:
        "Public-law database URLs require CORPUS_INDEX_SEARCH_ENDPOINT or CORPUS_INDEX_Q09_SEARCH_ENDPOINT.",
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
      },
    },
    {
      expected:
        "CORPUS_INDEX_ENDPOINT and CORPUS_INDEX_Q09_ENDPOINT must be unset when a public-law database URL is configured.",
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
        CORPUS_INDEX_ENDPOINT: "https://quickwit-admin.example.com",
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://quickwit-search.example.com",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
      },
    },
    {
      expected:
        "CORPUS_INDEXING_ENABLED must be false when a public-law database URL is configured.",
      overrides: {
        PUBLIC_LAW_DATABASE_URL:
          "postgres://case_law_reader:password@db.example.com:5432/stella?sslmode=require",
        CORPUS_INDEXING_ENABLED: "true",
        CORPUS_INDEX_SEARCH_ENDPOINT: "https://quickwit-search.example.com",
        LEGAL_SEARCH_PROVIDER: "corpus-index",
      },
    },
    {
      expected:
        "S3_ENDPOINT must use HTTPS unless it targets a loopback address.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        S3_ENDPOINT: "http://storage.example.com",
      },
    },
    {
      expected:
        "REDIS_URL must use rediss:// unless it targets loopback or Railway private networking.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        REDIS_URL: "redis://cache.example.com:6379",
      },
    },
    {
      expected:
        "BETTER_AUTH_URL must use HTTPS unless it targets a loopback address.",
      overrides: {
        BETTER_AUTH_URL: "http://api.example.com",
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
      },
    },
    {
      expected:
        "FRONTEND_URL must use HTTPS unless it targets a loopback address.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        FRONTEND_URL: "http://workspace.example.com",
        NODE_ENV: "production",
      },
    },
    {
      expected:
        "PUBLIC_URL must use HTTPS unless it targets a loopback address.",
      overrides: {
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        PUBLIC_URL: "http://public-api.example.com",
      },
    },
  ])("applies runtime invariant: $expected", ({ expected, overrides }) => {
    const result = validateDoctorEnvironment({
      app: "api",
      input: { ...validApiInput(), ...overrides },
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(expected);
    }
  });

  // The other half of the `on` invariant above: it must refuse exactly one
  // mode. A guard that rejected `shadow` too would block the only way to
  // gather the evidence for lifting it. Removed with the invariant, in the PR
  // that makes a corpus cursor carry its dictionary version.
  test.each(["off", "shadow"] as const)(
    "QUERY_EXPANSION_MODE=%p passes the runtime invariants",
    (mode) => {
      expect(
        validateDoctorEnvironment({
          app: "api",
          input: { ...validApiInput(), QUERY_EXPANSION_MODE: mode },
        }).status,
      ).toBe("valid");
    },
  );

  test("applies the selected API mode to runtime invariants", () => {
    const result = validateDoctorEnvironment({
      app: "api",
      input: validApiInput(),
      mode: "production",
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.",
      );
    }
  });

  test("applies the web runtime invariant", () => {
    const result = validateDoctorEnvironment({
      app: "web",
      input: {
        ...parseEnvText(renderWebEnvExample()),
        VITE_PUBLIC_LAW_ENABLED: "false",
        VITE_PUBLIC_LAW_INDEXING_ENABLED: "true",
      },
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "VITE_PUBLIC_LAW_INDEXING_ENABLED requires VITE_PUBLIC_LAW_ENABLED.",
      );
    }
  });
});

describe("environment usage auditing", () => {
  test("finds static runtime, Vite, and deployment references", () => {
    const usages = findEnvUsages(
      ".github/workflows/example.yml",
      [
        'process.env["API_TOKEN"]',
        "Bun.env.RUNTIME_MODE",
        "import.meta.env.VITE_API_URL",
        'import.meta.env["VITE_PUBLIC_APP_URL"]',
        `${String.fromCodePoint(36)}{{ secrets.DEPLOY_KEY }}`,
        `image: ${String.fromCodePoint(36)}{STELLA_API_IMAGE:-stella:latest}`,
      ].join("\n"),
    );

    expect(usages.map(({ name }) => name).toSorted()).toEqual([
      "API_TOKEN",
      "RUNTIME_MODE",
      "STELLA_API_IMAGE",
      "VITE_API_URL",
      "VITE_PUBLIC_APP_URL",
    ]);
  });

  test("leaves workflow-scoped secrets outside the app runtime contract", () => {
    expect(
      findEnvUsages(
        ".github/workflows/example.yml",
        `${String.fromCodePoint(36)}{{ secrets.DEPLOY_KEY }}`,
      ),
    ).toEqual([]);
  });

  test("finds bare Docker build variables", () => {
    expect(
      findEnvUsages(
        "apps/web/Dockerfile",
        "FROM --platform=$BUILDPLATFORM image",
      ),
    ).toEqual([
      { file: "apps/web/Dockerfile", line: 1, name: "BUILDPLATFORM" },
    ]);
  });

  test("finds required shell environment inputs", () => {
    expect(
      findEnvUsages(
        "scripts/example.sh",
        `release_ref="${String.fromCodePoint(36)}{RELEASE_REF:?RELEASE_REF is required}"`,
      ),
    ).toEqual([{ file: "scripts/example.sh", line: 1, name: "RELEASE_REF" }]);
  });

  test("ignores dependency and cache paths at any depth", () => {
    expect(isIgnoredAuditPath("node_modules/package/Dockerfile")).toBe(true);
    expect(isIgnoredAuditPath("apps/web/node_modules/package/Dockerfile")).toBe(
      true,
    );
    expect(isIgnoredAuditPath(".cache/generated/Dockerfile")).toBe(true);
    expect(isIgnoredAuditPath("apps/api/Dockerfile")).toBe(false);
  });

  test("traces literal names through computed environment helpers", () => {
    const usages = findEnvUsages(
      "scripts/example.ts",
      [
        'const DEPLOYMENT_URL_ENV = "API_DEPLOYMENT_URL";',
        "const readEnv = (name: string) => process.env[name];",
        'readEnv("API_DEPLOYMENT_EXPECTED_COMMIT");',
        "readEnv(DEPLOYMENT_URL_ENV);",
        "readEnv(dynamicName);",
      ].join("\n"),
    );

    expect(usages).toEqual([
      {
        file: "scripts/example.ts",
        line: 3,
        name: "API_DEPLOYMENT_EXPECTED_COMMIT",
      },
      { file: "scripts/example.ts", line: 4, name: "API_DEPLOYMENT_URL" },
    ]);
  });

  test("traces object properties through destructured environment helpers", () => {
    const usages = findEnvUsages(
      "apps/legal-atlas-runner/src/env.ts",
      [
        "const readIntegerEnv = ({ name: envName }: IntegerEnvOptions) =>",
        "  Bun.env[envName];",
        "readIntegerEnv({",
        '  name: "MAX_CONCURRENT_DB_WRITES",',
        "});",
      ].join("\n"),
    );

    expect(usages).toEqual([
      {
        file: "apps/legal-atlas-runner/src/env.ts",
        line: 4,
        name: "MAX_CONCURRENT_DB_WRITES",
      },
    ]);
  });

  test("finds static Rust runtime and build-time environment reads", () => {
    expect(
      findEnvUsages(
        "apps/desktop/src-tauri/src/config.rs",
        [
          'option_env!("STELLA_DESKTOP_DEFAULT_ORIGINS");',
          'env!("STELLA_DESKTOP_BUILD_ID");',
          'std::env::var("STELLA_DESKTOP_ALLOWED_ORIGINS");',
          'std::env::var_os("STELLA_DESKTOP_BRIDGE_PORT");',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "apps/desktop/src-tauri/src/config.rs",
        line: 3,
        name: "STELLA_DESKTOP_ALLOWED_ORIGINS",
      },
      {
        file: "apps/desktop/src-tauri/src/config.rs",
        line: 4,
        name: "STELLA_DESKTOP_BRIDGE_PORT",
      },
      {
        file: "apps/desktop/src-tauri/src/config.rs",
        line: 1,
        name: "STELLA_DESKTOP_DEFAULT_ORIGINS",
      },
      {
        file: "apps/desktop/src-tauri/src/config.rs",
        line: 2,
        name: "STELLA_DESKTOP_BUILD_ID",
      },
    ]);
  });
});

describe("web container build arguments", () => {
  const DOLLAR = String.fromCodePoint(36);
  const reference = (name: string) => `${DOLLAR}{${name}}`;

  type BuilderStageOptions = {
    declarations: string[];
    exports: [name: string, value: string][];
  };

  const builderStage = ({ declarations, exports }: BuilderStageOptions) =>
    [
      "FROM oven/bun AS deps",
      "ARG DEPS_STAGE_ONLY",
      "FROM deps AS builder",
      ...declarations.map((declaration) => `ARG ${declaration}`),
      "ENV NODE_ENV=production",
      "RUN \\",
      ...exports.map(([name, value]) => `    ${name}="${value}" \\`),
      "    bun --filter @stll/web build",
    ].join("\n");

  test("cover every client key in the committed web Dockerfile", async () => {
    const dockerfile = await Bun.file(
      new URL("../apps/web/Dockerfile", import.meta.url),
    ).text();

    expect(
      findWebBuildArgGaps({
        clientKeys: Object.keys(WEB_ENV_SCHEMA),
        dockerfile,
      }),
    ).toEqual([]);
  });

  test("derive the deployment contract from schema exports", () => {
    const contract = JSON.parse(
      renderWebBuildContract({
        clientKeys: ["VITE_SECOND", "VITE_FIRST"],
        dockerfile: builderStage({
          declarations: ["FIRST_INPUT", "VITE_SECOND"],
          exports: [
            ["VITE_FIRST", reference("FIRST_INPUT")],
            ["VITE_SECOND", reference("VITE_SECOND")],
          ],
        }),
      }),
    );

    expect(contract).toEqual({
      version: 1,
      variables: {
        VITE_FIRST: "FIRST_INPUT",
        VITE_SECOND: "VITE_SECOND",
      },
    });
  });

  test("reject an indirect deployment mapping", () => {
    expect(() =>
      renderWebBuildContract({
        clientKeys: ["VITE_EXAMPLE"],
        dockerfile: builderStage({
          declarations: ["EXAMPLE_INPUT"],
          exports: [["VITE_EXAMPLE", `prefix-${reference("EXAMPLE_INPUT")}`]],
        }),
      }),
    ).toThrow("VITE_EXAMPLE must map directly to one build argument");
  });

  test("report a schema key the build command never exports", () => {
    const gaps = findWebBuildArgGaps({
      clientKeys: ["VITE_API_URL", "VITE_WORKFLOWS_ENABLED"],
      dockerfile: builderStage({
        declarations: ["PUBLIC_API_URL"],
        exports: [["VITE_API_URL", reference("PUBLIC_API_URL")]],
      }),
    });

    expect(gaps).toEqual([{ name: "VITE_WORKFLOWS_ENABLED", type: "missing" }]);
    expect(gaps.map(formatWebBuildArgGap).join("\n")).toContain(
      "VITE_WORKFLOWS_ENABLED",
    );
  });

  test("report an export whose build argument is never declared", () => {
    expect(
      findWebBuildArgGaps({
        clientKeys: ["VITE_API_URL"],
        dockerfile: builderStage({
          declarations: [],
          exports: [["VITE_API_URL", reference("PUBLIC_API_URL")]],
        }),
      }),
    ).toEqual([
      { name: "VITE_API_URL", reference: "PUBLIC_API_URL", type: "undeclared" },
    ]);
  });

  test("scope declared build arguments to the builder stage", () => {
    expect(
      findWebBuildArgGaps({
        clientKeys: ["VITE_API_URL"],
        dockerfile: builderStage({
          declarations: [],
          exports: [["VITE_API_URL", reference("DEPS_STAGE_ONLY")]],
        }),
      }),
    ).toEqual([
      {
        name: "VITE_API_URL",
        reference: "DEPS_STAGE_ONLY",
        type: "undeclared",
      },
    ]);
  });

  test("accept a declaration that carries a default", () => {
    expect(
      findWebBuildArgGaps({
        clientKeys: ["VITE_SELFHOST"],
        dockerfile: builderStage({
          declarations: ["VITE_SELFHOST=true"],
          exports: [["VITE_SELFHOST", reference("VITE_SELFHOST")]],
        }),
      }),
    ).toEqual([]);
  });

  test("reject an export backed only by ENV", () => {
    expect(
      findWebBuildArgGaps({
        clientKeys: ["VITE_WORKFLOWS_ENABLED"],
        dockerfile: [
          "FROM oven/bun AS builder",
          "ENV VITE_WORKFLOWS_ENABLED=false",
          "RUN \\",
          `    VITE_WORKFLOWS_ENABLED="${reference("VITE_WORKFLOWS_ENABLED")}" \\`,
          "    bun --filter @stll/web build",
        ].join("\n"),
      }),
    ).toEqual([
      {
        name: "VITE_WORKFLOWS_ENABLED",
        reference: "VITE_WORKFLOWS_ENABLED",
        type: "undeclared",
      },
    ]);
  });

  test("report an export the client schema does not declare", () => {
    expect(
      findWebBuildArgGaps({
        clientKeys: [],
        dockerfile: builderStage({
          declarations: ["VITE_RETIRED_FLAG"],
          exports: [["VITE_RETIRED_FLAG", reference("VITE_RETIRED_FLAG")]],
        }),
      }),
    ).toEqual([{ name: "VITE_RETIRED_FLAG", type: "unknown" }]);
  });

  test("fail loudly when the build command moves", () => {
    expect(() =>
      parseWebBuildContract("FROM oven/bun AS builder\nRUN bun run build\n"),
    ).toThrow("no longer runs");
  });
});
