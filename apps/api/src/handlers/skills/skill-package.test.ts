import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { LIMITS } from "@/api/lib/limits";

import {
  fetchSkillPackageFromUrl,
  parseUploadedSkillPackage,
  resolveGithubRefAndPath,
} from "./skill-package";

describe("agent skill package imports", () => {
  test("parses a single SKILL.md upload", async () => {
    const result = await parseUploadedSkillPackage(
      new File(
        [
          `---
name: contract-review
description: Review contracts using a structured checklist.
license: Apache-2.0
---

Follow the checklist.`,
        ],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.name).toBe("contract-review");
    expect(result.value.license).toBe("Apache-2.0");
    expect(result.value.resources).toEqual([]);
    expect(result.value.contentHash).toHaveLength(64);
  });

  test("parses zipped skill folders with read-only resources", async () => {
    const zip = new JSZip();
    zip.file(
      "skill/SKILL.md",
      `---
name: nda-review
description: Review NDAs.
---

Use the references.`,
    );
    zip.file("skill/references/checklist.md", "# Checklist");
    zip.file("skill/assets/example.txt", "Example");
    zip.file("skill/private/ignore.md", "Ignored");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const result = await parseUploadedSkillPackage(
      new File([buffer], "nda-review.zip", { type: "application/zip" }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.resources.map((resource) => resource.path)).toEqual([
      "assets/example.txt",
      "references/checklist.md",
    ]);
  });

  test("rejects skill names that cannot be used as a load-skill id", async () => {
    const result = await parseUploadedSkillPackage(
      new File(
        [
          `---
name: NDA Review
description: Bad name.
---

Instructions.`,
        ],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects oversized frontmatter before chat metadata storage", async () => {
    const result = await parseUploadedSkillPackage(
      new File(
        [
          `---
name: oversized-frontmatter
description: ${"x".repeat(LIMITS.agentSkillDescriptionMaxChars + 1)}
---

Instructions.`,
        ],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects oversized custom metadata before storage", async () => {
    const result = await parseUploadedSkillPackage(
      new File(
        [
          `---
name: oversized-metadata
description: Metadata value is too large.
metadata:
  oversized: ${"x".repeat(LIMITS.agentSkillMetadataValueMaxChars + 1)}
---

Instructions.`,
        ],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects zip uploads with too many files", async () => {
    const zip = new JSZip();
    zip.file(
      "skill/SKILL.md",
      `---
name: crowded-skill
description: Too many files.
---

Instructions.`,
    );
    for (let index = 0; index < LIMITS.agentSkillArchiveFilesMax; index++) {
      zip.file(`skill/references/${index}.md`, "Reference");
    }
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const result = await parseUploadedSkillPackage(
      new File([buffer], "crowded-skill.zip", { type: "application/zip" }),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects zip uploads with excessive uncompressed content", async () => {
    const zip = new JSZip();
    zip.file(
      "skill/SKILL.md",
      `---
name: huge-skill
description: Huge uncompressed content.
---

Instructions.`,
    );
    zip.file(
      "skill/references/huge.md",
      "x".repeat(LIMITS.agentSkillArchiveUncompressedMaxBytes + 1),
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const result = await parseUploadedSkillPackage(
      new File([buffer], "huge-skill.zip", { type: "application/zip" }),
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects unsafe GitHub URLs before persisting source URLs", async () => {
    const unsafeUrls = [
      "http://github.com/org/repo/tree/main/skill",
      "https://user:password@github.com/org/repo/tree/main/skill",
      "https://github.com/org/repo/tree/main/skill#fragment",
      "https://user:password@raw.githubusercontent.com/org/repo/main/skill/SKILL.md",
    ];

    for (const url of unsafeUrls) {
      const result = await fetchSkillPackageFromUrl(url);
      expect(Result.isError(result)).toBe(true);
    }
  });

  test("resolves GitHub skill paths with multi-segment refs", async () => {
    const result = await resolveGithubRefAndPath({
      minPathParts: 0,
      owner: "org",
      parts: ["feature", "foo", "skill"],
      refExists: async ({ ref }) => ref === "feature/foo",
      repo: "repo",
    });

    expect(result).toEqual({ ref: "feature/foo", rootPath: "skill" });
  });

  test("prefers the longest matching GitHub ref before deriving the skill path", async () => {
    const result = await resolveGithubRefAndPath({
      minPathParts: 1,
      owner: "org",
      parts: ["release", "2026", "skills", "review", "SKILL.md"],
      refExists: async ({ ref }) => ref === "release/2026" || ref === "release",
      repo: "repo",
    });

    expect(result).toEqual({
      ref: "release/2026",
      rootPath: "skills/review",
    });
  });
});
