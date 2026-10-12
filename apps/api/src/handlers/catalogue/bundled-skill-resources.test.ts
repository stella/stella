import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import { hashSkillPackage } from "@stll/skills/format";

import { toParsedBundledSkillPackage } from "./bundled-skill-resources";

describe("toParsedBundledSkillPackage", () => {
  it("parses catalogue skill frontmatter before persistence", () => {
    const resources = [
      {
        content: "Use this reference.",
        path: "references/checklist.md",
        sizeBytes: 19,
      },
    ];

    const result = toParsedBundledSkillPackage({
      expectedSlug: "contract-review-anthropic",
      resourceFiles: resources,
      source: `---
name: contract-review-anthropic
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
      name: "contract-review-anthropic",
      resources,
      sourceUrl: null,
      version: "1.2.3",
    });
    expect(result.value.body).not.toContain("---");
  });

  it("rejects bundled skill frontmatter that does not match the catalogue slug", () => {
    const result = toParsedBundledSkillPackage({
      expectedSlug: "contract-review-anthropic",
      resourceFiles: [],
      source: `---
name: different-skill
description: Review contracts.
---

Instructions.`,
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("skill package hash", () => {
  it("includes bundled resources in the content hash", () => {
    const resources = [
      {
        content: "alpha",
        path: "references/a.md",
        sizeBytes: 5,
      },
    ];

    expect(
      hashSkillPackage({
        resources,
        source: "body",
      }),
    ).not.toBe(
      hashSkillPackage({
        resources: [],
        source: "body",
      }),
    );
  });
});
