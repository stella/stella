import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createGithubCataloguePackageCache,
  parseInTreeCatalogueSkill,
  resolveCatalogueSkillPackage,
} from "@/api/handlers/catalogue/catalogue-skill-package";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { GithubSkillPath } from "@/api/lib/skill-package";

const inTreePayload = {
  slug: "contract-review",
  body: `---
name: contract-review
description: Review contracts using a structured checklist.
license: Apache-2.0
---

Follow the checklist.`,
  resourceFiles: [
    {
      content: "# Checklist",
      path: "references/checklist.md",
      sizeBytes: 11,
    },
  ],
} as const;

describe("resolveCatalogueSkillPackage", () => {
  test("parses an in-tree catalogue payload without touching the network", () => {
    const result = parseInTreeCatalogueSkill(inTreePayload);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.name).toBe("contract-review");
    expect(result.value.license).toBe("Apache-2.0");
    expect(result.value.resources.map((resource) => resource.path)).toEqual([
      "references/checklist.md",
    ]);
  });

  test("returns 404 for an unknown slug and never fetches upstream", async () => {
    let fetched = false;
    const result = await resolveCatalogueSkillPackage("does-not-exist", {
      fetchGithubSkill: async () => {
        fetched = true;
        return Result.ok({
          body: "",
          compatibility: null,
          contentHash: "",
          description: "",
          license: null,
          metadata: {},
          name: "",
          resources: [],
          sourceUrl: null,
          version: null,
        });
      },
    });

    expect(fetched).toBe(false);
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected an unknown slug to fail");
    }
    expect(result.error.status).toBe(404);
  });

  test("installs a github skill under the catalogue slug, not the upstream frontmatter name", async () => {
    // `jurisrank-csjn-analysis` is a real github-sourced catalogue
    // entry. Its upstream SKILL.md frontmatter name can differ from the
    // slug; the resolver must still resolve to the catalogue slug so the
    // stored row is findable by install-state matching and uninstall.
    const captured: { target: GithubSkillPath | null; sourceUrl: string } = {
      target: null,
      sourceUrl: "",
    };
    const result = await resolveCatalogueSkillPackage(
      "jurisrank-csjn-analysis",
      {
        fetchGithubSkill: async ({ target, sourceUrl }) => {
          captured.target = target;
          captured.sourceUrl = sourceUrl;
          return Result.ok({
            body: "Analyze the ruling.",
            compatibility: null,
            contentHash: "hash",
            description: "Upstream skill.",
            license: "cc-by-4.0",
            metadata: {},
            // Upstream frontmatter name deliberately differs from the slug.
            name: "jurisrank-upstream-name",
            resources: [],
            sourceUrl: `${sourceUrl}SKILL.md`,
            version: null,
          });
        },
      },
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.installSlug).toBe("jurisrank-csjn-analysis");
    expect(result.value.package.name).toBe("jurisrank-upstream-name");
    // The pinned commit SHA (not a branch) is threaded through as the ref.
    expect(captured.target?.ref).toMatch(/^[0-9a-f]{40}$/u);
    expect(captured.sourceUrl).toContain("raw.githubusercontent.com");
    expect(result.value.package.license).toBe("CC-BY-4.0");
  });

  test("rejects an upstream license that differs from the reviewed manifest", async () => {
    const result = await resolveCatalogueSkillPackage(
      "jurisrank-csjn-analysis",
      {
        fetchGithubSkill: async () =>
          Result.ok(parsedGithubPackage({ license: "MIT" })),
      },
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected a mismatched license to fail");
    }
    expect(result.error.status).toBe(502);
  });
});

describe("github catalogue package cache", () => {
  test("coalesces concurrent requests and returns isolated package clones", async () => {
    let fetchCount = 0;
    let releaseFetch = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const cache = createGithubCataloguePackageCache({
      fetchPackage: async () => {
        fetchCount += 1;
        await fetchGate;
        return Result.ok(parsedGithubPackage());
      },
    });
    const options = githubPackageOptions();

    const firstPending = cache(options);
    const secondPending = cache(options);
    expect(fetchCount).toBe(1);
    releaseFetch();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first) || Result.isError(second)) {
      throw new TypeError("expected cached fetches to succeed");
    }
    first.value.metadata["mutated"] = "yes";
    const firstResource = first.value.resources.at(0);
    if (!firstResource) {
      throw new TypeError("expected the fetched package to have a resource");
    }
    firstResource.content = "mutated";
    expect(second.value.metadata).toEqual({ author: "Stella" });
    expect(second.value.resources.at(0)?.content).toBe("Reference");

    const third = await cache(options);
    expect(Result.isOk(third)).toBe(true);
    if (Result.isError(third)) {
      throw third.error;
    }
    expect(third.value.metadata).toEqual({ author: "Stella" });
    expect(third.value.resources.at(0)?.content).toBe("Reference");
    expect(fetchCount).toBe(1);
  });

  test("drops failures so a later request retries", async () => {
    let fetchCount = 0;
    const cache = createGithubCataloguePackageCache({
      fetchPackage: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? Result.err(
              new HandlerError({
                status: 503,
                message: "GitHub is temporarily unavailable",
              }),
            )
          : Result.ok(parsedGithubPackage());
      },
    });

    expect(Result.isError(await cache(githubPackageOptions()))).toBe(true);
    expect(Result.isOk(await cache(githubPackageOptions()))).toBe(true);
    expect(fetchCount).toBe(2);
  });

  test("evicts the least-recently-used pin when the bound is reached", async () => {
    let fetchCount = 0;
    const cache = createGithubCataloguePackageCache({
      maxEntries: 1,
      fetchPackage: async () => {
        fetchCount += 1;
        return Result.ok(parsedGithubPackage());
      },
    });
    const first = githubPackageOptions();
    const second = {
      ...first,
      target: { ...first.target, ref: "b".repeat(40) },
    };

    await cache(first);
    await cache(second);
    await cache(first);
    expect(fetchCount).toBe(3);
  });
});

const githubPackageOptions = () => ({
  sourceUrl: `https://raw.githubusercontent.com/acme/legal/${"a".repeat(40)}`,
  target: {
    owner: "acme",
    ref: "a".repeat(40),
    repo: "legal",
    rootPath: "skills/review",
  },
});

const parsedGithubPackage = ({ license = "CC-BY-4.0" } = {}) => ({
  body: "Review the agreement.",
  compatibility: null,
  contentHash: "hash",
  description: "Review agreements.",
  license,
  metadata: { author: "Stella" },
  name: "review",
  resources: [
    {
      content: "Reference",
      kind: "reference" as const,
      path: "references/review.md",
      sizeBytes: 9,
    },
  ],
  sourceUrl: null,
  version: null,
});
