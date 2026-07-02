import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  parseInTreeCatalogueSkill,
  resolveCatalogueSkillPackage,
} from "@/api/handlers/catalogue/catalogue-skill-package";

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
});
