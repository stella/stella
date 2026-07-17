import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  fetchGithubCatalogueSkillPackage,
  fetchSkillPackageFromUrl,
  githubSkillFetchHeaders,
  isZipSkillSource,
  parseUploadedSkillPackage,
  redactSkillSourceUrlForStorage,
  resolveGithubRefAndPath,
} from "./skill-package";
import type { GithubSkillPath } from "./skill-package";

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
      // oxlint-disable-next-line no-await-in-loop -- sequential test assertions over a fixed input list
      const result = await fetchSkillPackageFromUrl(url);
      expect(Result.isError(result)).toBe(true);
    }
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

    expect(result).toEqual({ ref: "feature/foo", rootPath: "skill" });
  });

  test("resolves GitHub skill paths pinned to commit SHAs", async () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const result = await resolveGithubRefAndPath({
      minPathParts: 1,
      owner: "org",
      parts: [commitSha, "skills", "review", "SKILL.md"],
      refExists: async () => false,
      repo: "repo",
    });

    expect(result).toEqual({
      ref: commitSha,
      rootPath: "skills/review",
    });
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

const PINNED_TARGET: GithubSkillPath = {
  owner: "acme",
  ref: "a".repeat(40),
  repo: "legal-skills",
  rootPath: "skills/german-law",
};
const PINNED_SOURCE_URL =
  "https://raw.githubusercontent.com/acme/legal-skills/" +
  `${"a".repeat(40)}/skills/german-law/`;
const encodedSize = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
const skillFile = (content: string) => ({
  content,
  path: "SKILL.md",
  sizeBytes: encodedSize(content),
});

describe("github catalogue skill fetch", () => {
  test("scopes the deployment token to curated GitHub API requests", () => {
    expect(
      githubSkillFetchHeaders({
        access: { source: "catalogue", githubToken: "secret-token" },
        hostname: "api.github.com",
      })["Authorization"],
    ).toBe("Bearer secret-token");
    expect(
      githubSkillFetchHeaders({
        access: { source: "catalogue", githubToken: "secret-token" },
        hostname: "raw.githubusercontent.com",
      })["Authorization"],
    ).toBeUndefined();
    expect(
      githubSkillFetchHeaders({
        access: { source: "user" },
        hostname: "api.github.com",
      })["Authorization"],
    ).toBeUndefined();
  });

  test("mirrors the whole pinned directory (SKILL.md plus resources)", async () => {
    // Captured via an object rather than closure-assigned `let`s: the
    // typechecker keeps a mutated object property at its declared type,
    // whereas a `let` reassigned only inside the fetch callback is flow-typed
    // back to its `null` initializer at the assertion below.
    const captured: { target: GithubSkillPath | null } = { target: null };
    const skillSource = `---
name: german-law
description: Community skill for German legal drafting.
license: MIT
---

Draft in German.`;
    const scriptSource = "print('draft')\n";

    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async (target) => {
        captured.target = target;
        return [
          skillFile(skillSource),
          {
            content: scriptSource,
            path: "scripts/draft.py",
            sizeBytes: encodedSize(scriptSource),
          },
        ];
      },
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(captured.target).toEqual(PINNED_TARGET);
    expect(result.value.name).toBe("german-law");
    expect(result.value.license).toBe("MIT");
    // Resource files travel with the install, unlike the SKILL.md-only v1.
    expect(result.value.resources.map((resource) => resource.path)).toEqual([
      "scripts/draft.py",
    ]);
    expect(result.value.sourceUrl).toBe(PINNED_SOURCE_URL);
  });

  test("maps invalid upstream catalogue content to a bad gateway error", async () => {
    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async () => {
        throw new HandlerError({
          status: 400,
          message: "Skill source returned HTTP 404",
        });
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected a non-200 response to fail");
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe("Catalogue skill package is invalid");
  });

  test("preserves temporary upstream availability failures", async () => {
    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async () => {
        throw new HandlerError({
          status: 503,
          message: "GitHub is temporarily unavailable",
        });
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected an upstream availability error");
    }
    expect(result.error.status).toBe(503);
  });

  test("rejects resource paths longer than the database boundary", async () => {
    const skillSource = `---
name: long-path
description: Resource path is too long.
license: MIT
---

Body.`;
    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async () => [
        skillFile(skillSource),
        {
          content: "Reference",
          path: `references/${"a".repeat(LIMITS.agentSkillResourcePathMaxChars)}.md`,
          sizeBytes: 9,
        },
      ],
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected an overlong resource path to fail");
    }
    expect(result.error.status).toBe(502);
  });

  test("rejects resource paths that collide after normalization", async () => {
    const skillSource = `---
name: duplicate-path
description: Resource paths collide after normalization.
license: MIT
---

Body.`;
    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async () => [
        skillFile(skillSource),
        {
          content: "First",
          path: "references/section/../same.md",
          sizeBytes: 5,
        },
        {
          content: "Second",
          path: "references/same.md",
          sizeBytes: 6,
        },
      ],
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected normalized duplicate paths to fail");
    }
    expect(result.error.status).toBe(502);
  });

  test("rejects a SKILL.md whose instructions exceed the size cap", async () => {
    const result = await fetchGithubCatalogueSkillPackage({
      target: PINNED_TARGET,
      sourceUrl: PINNED_SOURCE_URL,
      fetchFiles: async () => [
        skillFile(`---
name: german-law
description: Community skill for German legal drafting.
license: MIT
---

${"x".repeat(LIMITS.agentSkillBodyMaxChars + 1)}`),
      ],
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected an oversized skill body to fail");
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe("Catalogue skill package is invalid");
  });
});
