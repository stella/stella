import { describe, expect, test } from "bun:test";

import fixture from "./__fixtures__/lookup-cd-projekt.json" with { type: "json" };
import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseEntity } from "./parse.js";
import type { KrsLookupResponse } from "./types.js";

// SAFETY: captured official fixture is consumed by the defensive parser.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const raw = fixture as unknown as KrsLookupResponse;

describe("KRS normalized projection", () => {
  test("preserves alternate IDs, registry record, and structured capital", () => {
    const entity = toNormalizedEntity(parseEntity(raw, "0000006865"));
    expect(entity.identifiers.map((item) => item.scheme)).toEqual([
      "PL-NIP",
      "PL-REGON",
    ]);
    expect(entity.registryRecord).toMatchObject({
      availability: "available",
      value: { section: "RejP", idNumber: "0000006865" },
    });
    expect(entity.shareCapital).toMatchObject({
      availability: "available",
      value: { currency: "PLN" },
    });
    if (entity.shareCapital.availability === "available") {
      expect(entity.shareCapital.value?.amount).not.toBeNull();
    }
    expect(entity.keyPeople).toEqual({ availability: "not-supported" });
    expect(entity.registrationDate).toEqual({
      availability: "available",
      value: "2001-04-06",
    });
  });

  test("can derive a normalized search row from a lookup entity", () => {
    const result = toNormalizedSearchResult(parseEntity(raw, "0000006865"));
    expect(result.registryId.scheme).toBe("PL-KRS");
    expect(String(result.registryId.value)).toBe("0000006865");
    expect(result.status.availability).toBe("available");
  });

  test("does not expose invalid or ambiguous registry dates", () => {
    const source = parseEntity(raw, "0000006865");
    for (const registeredAt of ["31.02.2001", "2001-04-06", "unknown"]) {
      expect(
        toNormalizedEntity({ ...source, registeredAt }).registrationDate,
      ).toEqual({ availability: "available", value: null });
    }
  });
});
