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

  test("accepts only the exact reviewed Markdown index for its source", () => {
    const CLDR = {
      dependencies: ["cldr-misc-full"],
      indexKind: "reviewed-markdown",
      url: "https://raw.githubusercontent.com/unicode-org/cldr/main/docs/ldml/tr35.md",
    } as const;
    const policy = {
      dependencies: new Set(["cldr-misc-full"]),
      exclusions: [],
    } as const;

    expect(
      checkDocumentationSourcePolicy({
        ...policy,
        sources: { CLDR },
      }),
    ).toEqual([]);
    expect(
      checkDocumentationSourcePolicy({
        ...policy,
        sources: {
          CLDR: { ...CLDR, url: "https://example.com/tr35.md" },
        },
      }),
    ).toContain("CLDR must use its reviewed HTTPS Markdown index URL.");
    expect(
      checkDocumentationSourcePolicy({
        ...policy,
        sources: { Mirror: CLDR },
      }),
    ).toContain("Mirror must use its reviewed HTTPS Markdown index URL.");
    expect(
      checkDocumentationSourcePolicy({
        ...policy,
        sources: {
          CLDR: {
            dependencies: CLDR.dependencies,
            url: CLDR.url,
          },
        },
      }),
    ).toContain("CLDR must use an HTTPS URL ending in /llms.txt.");
  });

  test("never fails on time alone and rejects quarantines longer than one month", () => {
    // An elapsed quarantine is the dated waiver check's to enforce.
    expect(
      checkDocumentationSourcePolicy({
        dependencies: new Set(["documented-package", "undocumented-package"]),
        exclusions: quarantine("2026-08-27T00:00:00.000Z"),
        sources: SOURCE,
      }),
    ).toEqual([]);

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
