import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkDocumentationSourcePolicy,
  readFirstLevelDependencies,
} from "../docs-source-policy";

const SOURCE = {
  Example: {
    dependencies: ["documented-package"],
    url: "https://example.com/llms.txt",
  },
} as const;

const quarantine = (expiresAt: string) =>
  [
    {
      dependency: "undocumented-package",
      reason: "no-llms-txt",
      explanation: "The canonical documentation had no llms.txt endpoint.",
      checkedAt: "2026-08-26T00:00:00.000Z",
      expiresAt,
    },
  ] as const;

describe("documentation source policy rule", () => {
  test("accepts exhaustive source coverage and a current quarantine", () => {
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package", "undocumented-package"]),
        exclusions: quarantine("2026-09-25T00:00:00.000Z"),
        sources: SOURCE,
      }),
    ).toEqual([]);
  });

  test("rejects unclassified and stale policy entries", () => {
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["new-package"]),
        exclusions: quarantine("2026-09-25T00:00:00.000Z"),
        sources: SOURCE,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("new-package"),
        expect.stringContaining("documented-package"),
        expect.stringContaining("undocumented-package"),
      ]),
    );
  });

  test("rejects dependencies classified more than once", () => {
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package"]),
        exclusions: [
          {
            ...quarantine("2026-09-25T00:00:00.000Z")[0],
            dependency: "documented-package",
          },
        ],
        sources: SOURCE,
      }),
    ).toContain(
      "documented-package is classified by source Example and exclusion.",
    );
  });

  // The verdict is a function of the policy alone: a quarantine whose expiry
  // has long passed is still well formed, and its expiry belongs to
  // scripts/dated-waivers.ts, which scopes it to changes touching the policy.
  test("accepts a lapsed quarantine, whose expiry the dated waiver check owns", () => {
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package", "undocumented-package"]),
        exclusions: quarantine("2000-01-02T00:00:00.000Z").map((entry) => ({
          ...entry,
          checkedAt: "2000-01-01T00:00:00.000Z",
        })),
        sources: SOURCE,
      }),
    ).toEqual([]);
  });

  test("rejects quarantines longer than one month", () => {
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package", "undocumented-package"]),
        exclusions: quarantine("2026-10-01T00:00:00.000Z"),
        sources: SOURCE,
      }),
    ).toContain(
      "undocumented-package has a no-llms-txt quarantine longer than 31 days.",
    );
  });

  test("requires an explanation and exact UTC quarantine timestamps", () => {
    const baseExclusion = quarantine("2026-09-25T00:00:00.000Z")[0];
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package", "undocumented-package"]),
        exclusions: [
          {
            ...baseExclusion,
            checkedAt: "2026-08-26",
            explanation: " ",
          },
        ],
        sources: SOURCE,
      }),
    ).toEqual(
      expect.arrayContaining([
        "undocumented-package has no exclusion explanation.",
        "undocumented-package has an invalid no-llms-txt checkedAt timestamp.",
      ]),
    );
  });

  test("scans only first-level external workspace dependencies", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-doc-policy-"));
    try {
      mkdirSync(path.join(root, ".claude", "mcp"), { recursive: true });
      mkdirSync(path.join(root, "apps", "web"), { recursive: true });
      mkdirSync(path.join(root, "packages"));
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          dependencies: {
            "root-package": "1.0.0",
            "@stll/internal": "workspace:*",
          },
        }),
      );
      writeFileSync(
        path.join(root, "apps", "web", "package.json"),
        JSON.stringify({ devDependencies: { "app-package": "1.0.0" } }),
      );
      writeFileSync(
        path.join(root, ".claude", "mcp", "package.json"),
        JSON.stringify({ dependencies: { "mcp-only-package": "1.0.0" } }),
      );

      expect(readFirstLevelDependencies(root)).toEqual(
        new Set(["app-package", "root-package"]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
