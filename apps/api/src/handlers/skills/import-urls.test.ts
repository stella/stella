import { describe, expect, test } from "bun:test";

import {
  deduplicateSkillImportItems,
  skillImportRequestBudget,
} from "./import-urls.logic";

const contentIntegrity = (value: string) => ({
  type: "content-hash" as const,
  value,
});

const githubIntegrity = (
  value: string,
  entrypointHash: string,
  sourceUrl: string,
) => ({
  entrypointHash,
  sourceUrl,
  type: "github-commit" as const,
  value,
});

describe("skill URL import batches", () => {
  test("derives a request budget that covers every accepted package shape", () => {
    expect(
      skillImportRequestBudget({
        maxGithubDirectories: 76,
        maxImports: 1,
        maxResourcesPerSkill: 50,
      }),
    ).toBeGreaterThanOrEqual(129);
  });

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
          reportedSourceUrl: "https://example.com/SKILL.md",
          sourceUrl: "https://example.com/SKILL.md",
        },
      ],
    });
  });

  test("canonicalizes equivalent content-source URLs before deduplicating", () => {
    const integrity = contentIntegrity("a".repeat(64));
    const result = deduplicateSkillImportItems([
      { integrity, sourceUrl: "https://EXAMPLE.com:443/SKILL.md" },
      { integrity, sourceUrl: "https://example.com/SKILL.md" },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [
        {
          integrity,
          reportedSourceUrl: "https://EXAMPLE.com:443/SKILL.md",
          sourceUrl: "https://example.com/SKILL.md",
        },
      ],
    });
  });

  test("deduplicates content-identical packages across mirror URLs", () => {
    const integrity = contentIntegrity("a".repeat(64));
    const result = deduplicateSkillImportItems([
      { integrity, sourceUrl: "https://primary.example/SKILL.md" },
      { integrity, sourceUrl: "https://mirror.example/SKILL.md" },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [
        {
          integrity,
          reportedSourceUrl: "https://primary.example/SKILL.md",
          sourceUrl: "https://primary.example/SKILL.md",
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
    const integrity = githubIntegrity(
      "a".repeat(40),
      "b".repeat(64),
      sourceUrl,
    );
    const result = deduplicateSkillImportItems([
      { integrity, sourceUrl },
      { integrity, sourceUrl },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [{ integrity, reportedSourceUrl: sourceUrl, sourceUrl }],
    });
  });

  test("rejects GitHub previews with conflicting entrypoint hashes", () => {
    const sourceUrl = `https://github.com/example/skills/tree/${"a".repeat(40)}/review`;
    const result = deduplicateSkillImportItems([
      {
        integrity: githubIntegrity("a".repeat(40), "b".repeat(64), sourceUrl),
        sourceUrl,
      },
      {
        integrity: githubIntegrity("a".repeat(40), "c".repeat(64), sourceUrl),
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

  test("canonicalizes equivalent pinned GitHub URLs before deduplicating", () => {
    const commitSha = "a".repeat(40);
    const canonicalSourceUrl = `https://github.com/example/skills/tree/${commitSha}/Review%20Skill`;
    const integrity = githubIntegrity(
      commitSha,
      "b".repeat(64),
      canonicalSourceUrl,
    );
    const result = deduplicateSkillImportItems([
      {
        integrity,
        sourceUrl: `https://github.com/Example/Skills.git/tree/${commitSha}/Review%20Skill/`,
      },
      { integrity, sourceUrl: canonicalSourceUrl },
    ]);

    expect(result).toEqual({
      failed: [],
      items: [
        {
          integrity,
          reportedSourceUrl: `https://github.com/Example/Skills.git/tree/${commitSha}/Review%20Skill/`,
          sourceUrl: canonicalSourceUrl,
        },
      ],
    });
  });

  test("rejects unpinned GitHub commit items before import fetching", () => {
    const sourceUrl =
      "https://github.com/example/skills/tree/main/review/SKILL.md";
    const commitSha = "a".repeat(40);
    const result = deduplicateSkillImportItems([
      {
        integrity: githubIntegrity(
          commitSha,
          "b".repeat(64),
          `https://github.com/example/skills/tree/${commitSha}/review`,
        ),
        sourceUrl,
      },
    ]);

    expect(result.items).toEqual([]);
    expect(result.failed).toEqual([
      {
        message: "Skill source changed after discovery; review it again",
        sourceUrl,
      },
    ]);
  });

  test("rejects a different GitHub skill path before import fetching", () => {
    const commitSha = "a".repeat(40);
    const discoveredSourceUrl = `https://github.com/example/skills/tree/${commitSha}/reviewed`;
    const requestedSourceUrl = `https://github.com/example/skills/tree/${commitSha}/other`;
    const result = deduplicateSkillImportItems([
      {
        integrity: githubIntegrity(
          commitSha,
          "b".repeat(64),
          discoveredSourceUrl,
        ),
        sourceUrl: requestedSourceUrl,
      },
    ]);

    expect(result.items).toEqual([]);
    expect(result.failed).toEqual([
      {
        message: "Skill source changed after discovery; review it again",
        sourceUrl: requestedSourceUrl,
      },
    ]);
  });
});
