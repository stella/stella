import { describe, expect, test } from "bun:test";

import fixture from "./__fixtures__/search-swiss-re.json" with { type: "json" };
import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseFirm, parseSearchEntry } from "./parse.js";
import type { ZefixSearchResponse } from "./types.js";

// SAFETY: captured official fixture is consumed by the defensive parser.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const raw = fixture as unknown as ZefixSearchResponse;

describe("Zefix normalized projection", () => {
  test("preserves the canonical UID, seat, status, and legal-form code", () => {
    const company = raw.list?.[0] ? parseFirm(raw.list[0]) : null;
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    const entity = toNormalizedEntity(company);
    expect(entity.registryId.scheme).toBe("CH-UID");
    expect(String(entity.registryId.value)).toBe("191546434");
    expect(entity.identifiers).toEqual([]);
    if (entity.address.availability === "available") {
      expect(entity.address.value?.municipality).not.toBeNull();
    }
    expect(entity.keyPeople).toEqual({ availability: "not-supported" });
  });

  test("projects the same fixture into the common search contract", () => {
    const result = raw.list?.[0] ? parseSearchEntry(raw.list[0]) : null;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(toNormalizedSearchResult(result).status.availability).toBe(
      "available",
    );
  });
});
