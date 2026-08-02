import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { ENV_CATALOG, ENV_EXPOSURE, ENV_OWNER } from "./env-catalog";
import {
  findEnvUsages,
  formatEnvIssue,
  formatEnvValue,
  parseEnvText,
  renderApiEnvExample,
  renderCollabEnvExample,
  renderWebEnvExample,
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
});

describe("environment file parsing", () => {
  test("reads active quoted assignments and ignores comments", () => {
    expect(
      parseEnvText('ACTIVE="value"\n# SECRET="hidden"\nexport EMPTY=\'\'\n'),
    ).toEqual({ ACTIVE: "value", EMPTY: "" });
  });
});

describe("environment doctor output", () => {
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
});

describe("environment usage auditing", () => {
  test("finds static runtime, Vite, and workflow references", () => {
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
      "DEPLOY_KEY",
      "RUNTIME_MODE",
      "STELLA_API_IMAGE",
      "VITE_API_URL",
      "VITE_PUBLIC_APP_URL",
    ]);
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
