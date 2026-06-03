import { describe, expect, test } from "bun:test";

import {
  createAvailableCaseLawDecisionSlug,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";

describe("case-law public slugs", () => {
  test("normalizes case numbers into stable ASCII slugs", () => {
    expect(createCaseLawDecisionSlug("Nao 66/2026")).toBe("nao-66-2026");
    expect(createCaseLawDecisionSlug("ÚS 10/24")).toBe("us-10-24");
    expect(createCaseLawDecisionSlug("!!!")).toBe("unknown");
  });

  test("allocates numeric suffixes only for real collisions", () => {
    expect(
      createAvailableCaseLawDecisionSlug("nao-66-2026", [
        "nao-66-2026",
        "nao-66-2026-2",
        "nao-66-2026-title",
      ]),
    ).toBe("nao-66-2026-3");
  });

  test("fills gaps instead of growing suffixes forever", () => {
    expect(
      createAvailableCaseLawDecisionSlug("nao-66-2026", [
        "nao-66-2026",
        "nao-66-2026-3",
      ]),
    ).toBe("nao-66-2026-2");
  });

  test("keeps suffixed slugs within the database column limit", () => {
    const baseSlug = "a".repeat(256);
    const candidate = createAvailableCaseLawDecisionSlug(baseSlug, [baseSlug]);

    expect(candidate).toHaveLength(256);
    expect(candidate.endsWith("-2")).toBe(true);
  });
});
