import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { LIMITS } from "@/api/lib/limits";

import {
  createSkillPackageFetchContext,
  decodeGithubPathParts,
  discoverSkillPackagesFromUrl,
  fetchSkillPackageFromUrl,
  findGithubSkillEntrypoints,
  getOrCreateGithubTreeRequest,
  isZipSkillSource,
  parseUploadedSkillPackage,
  redactSkillSourceUrlForStorage,
  resolveGithubRefAndPath,
  verifySkillPackageIntegrity,
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
    expect(result.value.entrypointHash).toHaveLength(64);
    expect(
      Result.isOk(
        verifySkillPackageIntegrity({
          integrity: {
            type: "content-hash",
            value: result.value.contentHash,
          },
          parsed: result.value,
          sourceUrl: "https://example.com/SKILL.md",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        verifySkillPackageIntegrity({
          integrity: { type: "content-hash", value: "0".repeat(64) },
          parsed: result.value,
          sourceUrl: "https://example.com/SKILL.md",
        }),
      ),
    ).toBe(true);
    const commitSha = "a".repeat(40);
    const pinnedSourceUrl = `https://github.com/example/skills/tree/${commitSha}/review`;
    expect(
      Result.isOk(
        verifySkillPackageIntegrity({
          integrity: {
            type: "github-commit",
            entrypointHash: result.value.entrypointHash,
            sourceUrl: pinnedSourceUrl,
            value: commitSha,
          },
          parsed: result.value,
          sourceUrl: pinnedSourceUrl,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        verifySkillPackageIntegrity({
          integrity: {
            type: "github-commit",
            entrypointHash: result.value.entrypointHash,
            sourceUrl: pinnedSourceUrl,
            value: commitSha,
          },
          parsed: result.value,
          sourceUrl: `https://github.com/example/skills/tree/${commitSha}/other`,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        verifySkillPackageIntegrity({
          integrity: {
            type: "github-commit",
            entrypointHash: result.value.entrypointHash,
            sourceUrl: pinnedSourceUrl,
            value: commitSha,
          },
          parsed: result.value,
          sourceUrl: "https://github.com/example/skills/tree/main/review",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        verifySkillPackageIntegrity({
          integrity: {
            type: "github-commit",
            entrypointHash: "0".repeat(64),
            sourceUrl: pinnedSourceUrl,
            value: commitSha,
          },
          parsed: result.value,
          sourceUrl: `https://github.com/example/skills/tree/${commitSha}/review`,
        }),
      ),
    ).toBe(true);
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
    expect(result.value.contentHash).not.toBe(result.value.entrypointHash);
    const commitSha = "b".repeat(40);
    const pinnedSourceUrl = `https://github.com/example/skills/tree/${commitSha}/nda-review`;
    expect(
      Result.isOk(
        verifySkillPackageIntegrity({
          integrity: {
            type: "github-commit",
            entrypointHash: result.value.entrypointHash,
            sourceUrl: pinnedSourceUrl,
            value: commitSha,
          },
          parsed: result.value,
          sourceUrl: pinnedSourceUrl,
        }),
      ),
    ).toBe(true);
  });

  test("hashes package fields with unambiguous boundaries", async () => {
    const source = `---
name: hash-boundaries
description: Verify canonical package hashing.
---

Instructions.`;
    const combined = new JSZip();
    combined.file("skill/SKILL.md", source);
    combined.file(
      "skill/references/a.md",
      "prefix\0references/b.md\0malicious",
    );
    const split = new JSZip();
    split.file("skill/SKILL.md", source);
    split.file("skill/references/a.md", "prefix");
    split.file("skill/references/b.md", "malicious");

    const [combinedBuffer, splitBuffer] = await Promise.all([
      combined.generateAsync({ type: "arraybuffer" }),
      split.generateAsync({ type: "arraybuffer" }),
    ]);
    const [combinedResult, splitResult] = await Promise.all([
      parseUploadedSkillPackage(
        new File([combinedBuffer], "combined.zip", {
          type: "application/zip",
        }),
      ),
      parseUploadedSkillPackage(
        new File([splitBuffer], "split.zip", { type: "application/zip" }),
      ),
    ]);

    expect(Result.isOk(combinedResult)).toBe(true);
    expect(Result.isOk(splitResult)).toBe(true);
    if (Result.isError(combinedResult) || Result.isError(splitResult)) {
      throw new TypeError("Package parsing unexpectedly failed");
    }
    expect(combinedResult.value.contentHash).not.toBe(
      splitResult.value.contentHash,
    );
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

  test("rejects bidi formatting controls in display metadata", async () => {
    for (const [field, value] of [
      ["version", `1.0.0${String.fromCodePoint(8297)}override`],
      ["license", `MIT${String.fromCodePoint(8238)}override`],
    ] as const) {
      const result = await parseUploadedSkillPackage(
        new File(
          [
            `---
name: unsafe-metadata
description: Metadata must not alter surrounding text direction.
${field}: ${value}
---

Instructions.`,
          ],
          "SKILL.md",
          { type: "text/markdown" },
        ),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isOk(result)) {
        throw new Error(`Expected ${field} bidi controls to be rejected`);
      }
      expect(result.error.message).toBe(
        `Skill ${field} contains bidirectional formatting controls`,
      );
    }
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
      const discovery = await discoverSkillPackagesFromUrl(url);
      expect(Result.isError(discovery)).toBe(true);
    }
  });

  test("rejects malformed GitHub repository coordinates before fetching", async () => {
    const malformedUrls = [
      "https://github.com/not_valid/repository",
      "https://github.com/example/...",
    ];

    for (const url of malformedUrls) {
      const result = await discoverSkillPackagesFromUrl(url);
      expect(Result.isError(result)).toBe(true);
    }
  });

  test("decodes GitHub path segments exactly once", () => {
    expect(
      decodeGithubPathParts(
        "/example/skills/tree/0123456789abcdef0123456789abcdef01234567/legal%20review/%25-check",
      ),
    ).toEqual([
      "example",
      "skills",
      "tree",
      "0123456789abcdef0123456789abcdef01234567",
      "legal review",
      "%-check",
    ]);
    expect(() =>
      decodeGithubPathParts("/example/skills/tree/main/legal%2Freview"),
    ).toThrow("GitHub URL path is invalid");
  });

  test("shares one GitHub tree request across a repository import batch", async () => {
    const context = createSkillPackageFetchContext();
    let loadCount = 0;
    const load = async () => {
      loadCount += 1;
      return [{ path: "review/SKILL.md", type: "blob" }];
    };

    const first = getOrCreateGithubTreeRequest({
      cacheKey: "example\u0000skills\u0000commit",
      context,
      load,
    });
    const second = getOrCreateGithubTreeRequest({
      cacheKey: "example\u0000skills\u0000commit",
      context,
      load,
    });

    expect(await Promise.all([first, second])).toEqual([
      [{ path: "review/SKILL.md", type: "blob" }],
      [{ path: "review/SKILL.md", type: "blob" }],
    ]);
    expect(loadCount).toBe(1);
  });

  test("discovers only SKILL.md entrypoints inside the selected folder", () => {
    const result = findGithubSkillEntrypoints({
      rootPath: "packages/legal",
      tree: [
        { path: "SKILL.md", type: "blob" },
        { path: "packages/legal/review/SKILL.md", type: "blob" },
        { path: "packages/legal/review/references/notes.md", type: "blob" },
        { path: "packages/legal/research/SKILL.md", type: "blob" },
        { path: "packages/legalish/other/SKILL.md", type: "blob" },
        { path: "packages/legal/directory/SKILL.md", type: "tree" },
      ],
    });

    expect(result).toEqual([
      "packages/legal/research/SKILL.md",
      "packages/legal/review/SKILL.md",
    ]);
  });

  test("bounds repository discovery before fetching skill bodies", () => {
    const tree = Array.from({ length: 51 }, (_, index) => ({
      path: `skills/skill-${index}/SKILL.md`,
      type: "blob",
    }));

    expect(() =>
      findGithubSkillEntrypoints({ rootPath: "skills", tree }),
    ).toThrow("at most 50 skills");
  });

  test("strips query strings from persisted skill source URLs", () => {
    expect(
      redactSkillSourceUrlForStorage(
        "https://example.com/skill.zip?token=secret&X-Amz-Signature=sig",
      ),
    ).toBe("https://example.com/skill.zip");
  });

  test("detects zip package URLs before query strings", async () => {
    const zip = new JSZip();
    zip.file(
      "skill/SKILL.md",
      `---
name: signed-zip
description: Imported from a signed URL.
---

Instructions.`,
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const url = new URL("https://example.com/skill.zip?X-Amz-Signature=secret");

    expect(
      isZipSkillSource({
        buffer,
        contentType: "application/octet-stream",
        path: url.pathname,
      }),
    ).toBe(true);
  });

  test("resolves GitHub skill paths with multi-segment refs", async () => {
    const result = await resolveGithubRefAndPath({
      minPathParts: 0,
      owner: "org",
      parts: ["feature", "foo", "skill"],
      refExists: async ({ ref }) => ref === "feature/foo",
      repo: "repo",
    });

    expect(result).toEqual({
      ref: "feature/foo",
      rootPath: "skill",
      selectedSkillPath: null,
    });
  });

  test("resolves GitHub skill paths pinned to commit SHAs", async () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    let refProbeCount = 0;
    const result = await resolveGithubRefAndPath({
      minPathParts: 1,
      owner: "org",
      parts: [commitSha, "skills", "review", "SKILL.md"],
      refExists: async () => {
        refProbeCount += 1;
        return false;
      },
      repo: "repo",
    });

    expect(result).toEqual({
      ref: commitSha,
      rootPath: "skills/review",
      selectedSkillPath: "skills/review/SKILL.md",
    });
    expect(refProbeCount).toBe(0);
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
      selectedSkillPath: "skills/review/SKILL.md",
    });
  });
});
