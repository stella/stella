import { describe, expect, test } from "bun:test";

import {
  buildSkillManifest,
  deriveSlug,
  evaluateManifest,
  firstCommitShaFromResponse,
  githubCommitsApiUrl,
  githubNewFileUrl,
  isFullCommitSha,
  normalizeGithubRepo,
  type ContributeFormState,
} from "@/routes/tools/-components/contribute.logic";

const SHA = "a".repeat(40);

const githubForm = (
  overrides: Partial<ContributeFormState> = {},
): ContributeFormState => ({
  name: "GDPR Helper",
  slug: "gdpr-helper",
  description: "Reviews processing agreements for GDPR compliance.",
  author: "Jane Doe",
  authorUrl: "",
  license: "MIT",
  cost: "free",
  setup: "none",
  jurisdictions: [],
  tags: [],
  source: "github",
  repo: "jane/gdpr-helper",
  directory: "",
  rev: SHA,
  ...overrides,
});

describe("deriveSlug", () => {
  test("kebab-cases and strips punctuation", () => {
    expect(deriveSlug("GDPR Helper!")).toBe("gdpr-helper");
    expect(deriveSlug("  Multi   Space  ")).toBe("multi-space");
  });

  test("folds diacritics", () => {
    expect(deriveSlug("Přehled Smluv")).toBe("prehled-smluv");
  });

  test("caps length and trims trailing hyphen", () => {
    const slug = deriveSlug("x".repeat(80));
    expect(slug.length).toBe(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("isFullCommitSha", () => {
  test("accepts full lowercase hex, rejects short or uppercase", () => {
    expect(isFullCommitSha(SHA)).toBe(true);
    expect(isFullCommitSha("abc123")).toBe(false);
    expect(isFullCommitSha("A".repeat(40))).toBe(false);
  });
});

describe("normalizeGithubRepo", () => {
  test("accepts bare owner/name", () => {
    expect(normalizeGithubRepo("jane/gdpr-helper")).toBe("jane/gdpr-helper");
  });

  test("strips host, www, trailing slash and .git", () => {
    expect(normalizeGithubRepo("https://github.com/jane/gdpr-helper")).toBe(
      "jane/gdpr-helper",
    );
    expect(normalizeGithubRepo("github.com/jane/gdpr-helper.git")).toBe(
      "jane/gdpr-helper",
    );
    expect(
      normalizeGithubRepo("https://www.github.com/jane/gdpr-helper/"),
    ).toBe("jane/gdpr-helper");
  });

  test("strips a combined trailing .git and slash", () => {
    expect(
      normalizeGithubRepo("https://github.com/jane/gdpr-helper.git/"),
    ).toBe("jane/gdpr-helper");
    expect(normalizeGithubRepo("jane/gdpr-helper.git/")).toBe(
      "jane/gdpr-helper",
    );
  });

  test("rejects non-repo input", () => {
    expect(normalizeGithubRepo("not a repo")).toBeNull();
    expect(normalizeGithubRepo("jane")).toBeNull();
  });
});

describe("githubCommitsApiUrl", () => {
  test("targets the newest commit only", () => {
    expect(githubCommitsApiUrl("jane/gdpr-helper")).toBe(
      "https://api.github.com/repos/jane/gdpr-helper/commits?per_page=1",
    );
  });
});

describe("firstCommitShaFromResponse", () => {
  test("extracts a valid SHA from the array head", () => {
    expect(
      firstCommitShaFromResponse([{ sha: SHA }, { sha: "b".repeat(40) }]),
    ).toBe(SHA);
  });

  test("returns null for empty, malformed, or abbreviated payloads", () => {
    expect(firstCommitShaFromResponse([])).toBeNull();
    expect(firstCommitShaFromResponse({ sha: SHA })).toBeNull();
    expect(firstCommitShaFromResponse([{ sha: "abc" }])).toBeNull();
    expect(firstCommitShaFromResponse(null)).toBeNull();
  });
});

describe("githubNewFileUrl", () => {
  test("deep-links the new-file editor at the manifest path", () => {
    const url = githubNewFileUrl({
      slug: "gdpr-helper",
      manifestJson: '{"a":1}',
    });
    expect(url).toBe(
      "https://github.com/stella/stella/new/main?filename=packages/catalogue/entries/skills/gdpr-helper/manifest.json&value=%7B%22a%22%3A1%7D",
    );
  });
});

describe("buildSkillManifest", () => {
  test("omits blank optionals and normalizes the repo", () => {
    const manifest = buildSkillManifest(
      githubForm({ repo: "https://github.com/jane/gdpr-helper.git" }),
    );
    expect(manifest["repo"]).toBe("jane/gdpr-helper");
    expect(manifest["rev"]).toBe(SHA);
    expect("authorUrl" in manifest).toBe(false);
    expect("directory" in manifest).toBe(false);
    expect("tags" in manifest).toBe(false);
  });

  test("in-tree variant emits entryPath and no repo fields", () => {
    const manifest = buildSkillManifest(githubForm({ source: "in-tree" }));
    expect(manifest["entryPath"]).toBe("SKILL.md");
    expect("repo" in manifest).toBe(false);
    expect("rev" in manifest).toBe(false);
  });

  test("includes non-empty tags, jurisdictions, and authorUrl", () => {
    const manifest = buildSkillManifest(
      githubForm({
        authorUrl: "https://example.com",
        tags: ["corporate"],
        jurisdictions: ["CZ"],
        directory: "skills/gdpr",
      }),
    );
    expect(manifest["authorUrl"]).toBe("https://example.com");
    expect(manifest["tags"]).toEqual(["corporate"]);
    expect(manifest["jurisdictions"]).toEqual(["CZ"]);
    expect(manifest["directory"]).toBe("skills/gdpr");
  });
});

describe("evaluateManifest", () => {
  test("valid github form passes schema validation", () => {
    const result = evaluateManifest(githubForm());
    expect(result.valid).toBe(true);
    expect(result.invalidFields).toEqual([]);
    expect(result.json).toContain('"kind": "skill"');
  });

  test("valid in-tree form passes schema validation", () => {
    expect(evaluateManifest(githubForm({ source: "in-tree" })).valid).toBe(
      true,
    );
  });

  test("flags an abbreviated rev as an invalid field", () => {
    const result = evaluateManifest(githubForm({ rev: "abc123" }));
    expect(result.valid).toBe(false);
    expect(result.invalidFields).toContain("rev");
  });

  test("flags a missing slug", () => {
    const result = evaluateManifest(githubForm({ slug: "" }));
    expect(result.valid).toBe(false);
    expect(result.invalidFields).toContain("slug");
  });
});
