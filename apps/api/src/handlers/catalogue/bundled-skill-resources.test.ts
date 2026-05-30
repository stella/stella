import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import {
  hashBundledSkillPackage,
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
        body: "body",
        resources,
      }),
    ).not.toBe(
      hashBundledSkillPackage({
        body: "body",
        resources: [],
      }),
    );
  });
});
