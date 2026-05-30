import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import {
  hashBundledSkillPackage,
  toParsedBundledSkillPackage,
  toParsedBundledSkillResources,
} from "./bundled-skill-resources";

describe("toParsedBundledSkillResources", () => {
  it("converts catalogue resource files into persisted skill resources", () => {
    const result = toParsedBundledSkillResources([
      {
        content: "Use this checklist.",
        path: "references/checklist.md",
        sizeBytes: 19,
      },
      {
        content: "template",
        path: "templates/base.txt",
        sizeBytes: 8,
      },
    ]);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value).toEqual([
      {
        content: "Use this checklist.",
        kind: "reference",
        path: "references/checklist.md",
        sizeBytes: 19,
      },
      {
        content: "template",
        kind: "template",
        path: "templates/base.txt",
        sizeBytes: 8,
      },
    ]);
  });

  it("rejects unsupported bundled resource paths", () => {
    const result = toParsedBundledSkillResources([
      {
        content: "ignored",
        path: "unknown/file.md",
        sizeBytes: 7,
      },
    ]);

    expect(Result.isError(result)).toBe(true);
  });
});

describe("toParsedBundledSkillPackage", () => {
  it("parses catalogue skill frontmatter before persistence", () => {
    const resources = [
      {
        content: "Use this reference.",
        kind: "reference" as const,
        path: "references/checklist.md",
        sizeBytes: 19,
      },
    ];

    const result = toParsedBundledSkillPackage({
      expectedSlug: "contract-review",
      resources,
      source: `---
name: contract-review
description: Review contracts using a structured checklist.
version: 1.2.3
license: Apache-2.0
compatibility: stella 1.x
metadata:
  category: contracts
---

# Instructions

Follow the checklist.`,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      body: "# Instructions\n\nFollow the checklist.",
      compatibility: "stella 1.x",
      description: "Review contracts using a structured checklist.",
      license: "Apache-2.0",
      metadata: { category: "contracts" },
      name: "contract-review",
      resources,
      sourceUrl: null,
      version: "1.2.3",
    });
    expect(result.value.body).not.toContain("---");
    expect(result.value.contentHash).toHaveLength(64);
  });

  it("rejects bundled skill frontmatter that does not match the catalogue slug", () => {
    const result = toParsedBundledSkillPackage({
      expectedSlug: "contract-review",
      resources: [],
      source: `---
name: different-skill
description: Review contracts.
---

Instructions.`,
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("hashBundledSkillPackage", () => {
  it("includes bundled resources in the content hash", () => {
    const resources = [
      {
        content: "alpha",
        kind: "reference" as const,
        path: "references/a.md",
        sizeBytes: 5,
      },
    ];

    expect(
      hashBundledSkillPackage({
        resources,
        source: "body",
      }),
    ).not.toBe(
      hashBundledSkillPackage({
        resources: [],
        source: "body",
      }),
    );
  });
});
