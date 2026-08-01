import { describe, expect, test } from "bun:test";

import {
  createCaseLawDecisionSlug,
  createCaseLawDecisionSlugCandidate,
} from "@/api/handlers/case-law/decisions/slug";

describe("case-law public slugs", () => {
  test("normalizes case numbers into stable ASCII slugs", () => {
    expect(createCaseLawDecisionSlug("Nao 66/2026")).toBe("nao-66-2026");
    expect(createCaseLawDecisionSlug("ÚS 10/24")).toBe("us-10-24");
    expect(createCaseLawDecisionSlug("!!!")).toBe("unknown");
  });

  test("keeps the base first, then derives stable collision candidates", () => {
    const baseSlug = "nao-66-2026";
    const identity = "source-id\u0000document\u0000publisher-id";

    expect(
      createCaseLawDecisionSlugCandidate({
        baseSlug,
        identity,
        attempt: 0,
      }),
    ).toBe(baseSlug);
    expect(
      createCaseLawDecisionSlugCandidate({
        baseSlug,
        identity,
        attempt: 1,
      }),
    ).toBe(
      createCaseLawDecisionSlugCandidate({
        baseSlug,
        identity,
        attempt: 1,
      }),
    );
    expect(
      createCaseLawDecisionSlugCandidate({
        baseSlug,
        identity,
        attempt: 1,
      }),
    ).not.toBe(
      createCaseLawDecisionSlugCandidate({
        baseSlug,
        identity: `${identity}-other`,
        attempt: 1,
      }),
    );
  });

  test("keeps deterministic collision candidates within the database column limit", () => {
    const baseSlug = "a".repeat(256);
    const candidate = createCaseLawDecisionSlugCandidate({
      baseSlug,
      identity: "source-id\u0000document\u0000publisher-id",
      attempt: 1,
    });

    expect(candidate).toHaveLength(256);
    expect(candidate).toMatch(/-[a-f0-9]{16}$/u);
  });

  test("keeps slug allocation free of database scans", async () => {
    const source = await Bun.file(new URL("slug.ts", import.meta.url)).text();

    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("caseLawDecisions");
    expect(source).not.toContain(".select(");
  });
});
