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
  findEnvUsages,
  formatEnvIssue,
  formatEnvValue,
  normalizeEmptyEnvironment,
  parseEnvText,
  renderApiEnvExample,
  renderCollabEnvExample,
  renderWebEnvExample,
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
});

describe("environment file parsing", () => {
  test("reads active quoted assignments and ignores comments", () => {
    expect(
      parseEnvText('ACTIVE="value"\n# SECRET="hidden"\nexport EMPTY=\'\'\n'),
    ).toEqual({ ACTIVE: "value", EMPTY: "" });
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

  test("does not echo invalid secrets in validation errors", () => {
    const secret = "actual-secret-value";
    const result = v.safeParse(
      v.object({ DATABASE_URL: v.pipe(v.string(), v.url()) }),
      { DATABASE_URL: secret },
    );
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const issue = result.issues.at(0);
    expect(issue).toBeDefined();
    if (!issue) {
      return;
    }
    const message = formatEnvIssue(issue);
    expect(message).toBe("DATABASE_URL: invalid secret value.");
    expect(message).not.toContain(secret);
  });

  test("normalizes empty schema values but preserves an empty database password", () => {
    expect(
      normalizeEmptyEnvironment({
        DB_PASSWORD: "",
        EMAIL_PROVIDER: "",
        OCR_SERVICE_URL: "",
      }),
    ).toEqual({
      DB_PASSWORD: "",
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

  test.each([
    {
      expected:
        "MICROSOFT_AUTH_TENANT_ID is required when Microsoft OAuth is configured.",
      overrides: { MICROSOFT_AUTH_CLIENT_ID: "client-id" },
    },
    {
      expected:
        "LEGAL_SEARCH_PROVIDER=corpus-index requires CORPUS_INDEX_ENDPOINT to be set",
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
});
