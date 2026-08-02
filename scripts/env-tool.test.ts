import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  ENV_CATALOG,
  ENV_EXPOSURE,
  ENV_OWNER,
  ENV_REQUIREMENT,
  requirementFor,
} from "./env-catalog";
import {
  doctorEnvFileNames,
  findEnvUsages,
  formatEnvIssue,
  formatEnvValue,
  isIgnoredAuditPath,
  normalizeEmptyEnvironment,
  parseEnvLayers,
  parseEnvText,
  renderApiEnvExample,
  renderCollabEnvExample,
  renderWebEnvExample,
  resolveDoctorMode,
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

  test("fails closed when Bun rejects nested fallbacks", () => {
    expect(() =>
      parseEnvText(`DB_PORT=\${MISSING_PORT:-\${PGPORT:-5432}}`, {
        PGPORT: "6432",
      }),
    ).toThrow("Bun failed to load environment layers.");
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
      ESCAPED: "$resolved",
      PREFIX: "resolved",
      RUN: "$",
      SUFFIX: "resolved$",
      VALUE: "resolved",
    });
  });

  test("delegates punctuation expansion to Bun", () => {
    expect(
      parseEnvText(`SECRET=${`${String.fromCodePoint(36)}-`.repeat(16)}`, {}),
    ).toEqual({ SECRET: "-".repeat(16) });
  });

  test("matches Bun dotenv layer order and final-value expansion", () => {
    expect(doctorEnvFileNames("production")).toEqual([
      ".env",
      ".env.production",
      ".env.local",
      ".env.production.local",
    ]);
    expect(doctorEnvFileNames("staging")).toEqual([".env", ".env.local"]);
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
  });
});

describe("environment doctor output", () => {
  const validApiInput = () => parseEnvText(renderApiEnvExample());

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
        OCR_SERVICE_URL: "",
      }),
    ).toEqual({
      DB_PASSWORD: "",
      DB_SSLMODE: "",
      EMAIL_PROVIDER: undefined,
      OCR_SERVICE_URL: undefined,
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

    const result = validateDoctorEnvironment("api", input);
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

    const result = validateDoctorEnvironment("api", input);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(
        "DATABASE_URL: invalid database component settings.",
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
        "LEGAL_SEARCH_PROVIDER=corpus-index requires CORPUS_INDEX_ENDPOINT to be set.",
      overrides: { LEGAL_SEARCH_PROVIDER: "corpus-index" },
    },
    {
      expected:
        "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.",
      overrides: { NODE_ENV: "production" },
    },
  ])("applies runtime invariant: $expected", ({ expected, overrides }) => {
    const result = validateDoctorEnvironment("api", {
      ...validApiInput(),
      ...overrides,
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues).toContain(expected);
    }
  });

  test("applies the web runtime invariant", () => {
    const result = validateDoctorEnvironment("web", {
      ...parseEnvText(renderWebEnvExample()),
      VITE_PUBLIC_LAW_ENABLED: "false",
      VITE_PUBLIC_LAW_INDEXING_ENABLED: "true",
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
