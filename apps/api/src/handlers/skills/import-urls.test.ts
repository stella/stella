import { describe, expect, test } from "bun:test";

import { deduplicateSkillImportItems } from "./import-urls.logic";

const contentIntegrity = (value: string) => ({
  type: "content-hash" as const,
  value,
});

const githubIntegrity = (value: string, entrypointHash: string) => ({
  entrypointHash,
  type: "github-commit" as const,
  value,
});

describe("skill URL import batches", () => {
  test("keeps identical duplicates as one import", () => {
    const integrity = contentIntegrity("a".repeat(64));
    const result = deduplicateSkillImportItems([
      { integrity, sourceUrl: " https://example.com/SKILL.md " },
      { integrity, sourceUrl: "https://example.com/SKILL.md" },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [
        {
          integrity,
          sourceUrl: "https://example.com/SKILL.md",
        },
      ],
    });
  });

  test("rejects a URL with conflicting preview integrity", () => {
    const sourceUrl = "https://example.com/SKILL.md";
    const result = deduplicateSkillImportItems([
      { integrity: contentIntegrity("a".repeat(64)), sourceUrl },
      { integrity: contentIntegrity("b".repeat(64)), sourceUrl },
    ]);

    expect(result.items).toEqual([]);
    expect(result.failed).toEqual([
      {
        message: "Duplicate skill URL has conflicting integrity values",
        sourceUrl,
      },
    ]);
  });

  test("keeps identical GitHub commit previews as one import", () => {
    const sourceUrl = `https://github.com/example/skills/tree/${"a".repeat(40)}/review`;
    const integrity = githubIntegrity("a".repeat(40), "b".repeat(64));
    const result = deduplicateSkillImportItems([
      { integrity, sourceUrl },
      { integrity, sourceUrl },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [{ integrity, sourceUrl }],
    });
  });

  test("rejects GitHub previews with conflicting entrypoint hashes", () => {
    const sourceUrl = `https://github.com/example/skills/tree/${"a".repeat(40)}/review`;
    const result = deduplicateSkillImportItems([
      {
        integrity: githubIntegrity("a".repeat(40), "b".repeat(64)),
        sourceUrl,
      },
      {
        integrity: githubIntegrity("a".repeat(40), "c".repeat(64)),
        sourceUrl,
      },
    ]);

    expect(result.items).toEqual([]);
    expect(result.failed).toEqual([
      {
        message: "Duplicate skill URL has conflicting integrity values",
        sourceUrl,
      },
    ]);
  });
});
