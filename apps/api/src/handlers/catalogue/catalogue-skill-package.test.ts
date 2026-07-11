import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  parseInTreeCatalogueSkill,
  resolveCatalogueSkillPackage,
} from "@/api/handlers/catalogue/catalogue-skill-package";
import type { GithubSkillPath } from "@/api/handlers/skills/skill-package";

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
    const result = await resolveCatalogueSkillPackage(
      "does-not-exist",
      async () => {
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
    );

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
      async (target, sourceUrl) => {
        captured.target = target;
        captured.sourceUrl = sourceUrl;
        return Result.ok({
          body: "Analyze the ruling.",
          compatibility: null,
          contentHash: "hash",
          description: "Upstream skill.",
          license: "MIT",
          metadata: {},
          // Upstream frontmatter name deliberately differs from the slug.
          name: "jurisrank-upstream-name",
          resources: [],
          sourceUrl: `${sourceUrl}SKILL.md`,
          version: null,
        });
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
  });
});
