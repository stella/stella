import { describe, expect, test } from "bun:test";

import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseExtract } from "./parse.js";
import type { OrsrRawExtractResponse } from "./types.js";

const readFixture = async (): Promise<OrsrRawExtractResponse> => {
  const value: unknown = await Bun.file(
    new URL("__fixtures__/extract-eset.json", import.meta.url),
  ).json();
  // SAFETY: captured registry fixture is consumed by the defensive parser.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as OrsrRawExtractResponse;
};

describe("ORSR normalized projection", () => {
  test("preserves court, capital, acting, and grouped people", async () => {
    const company = parseExtract(await readFixture());
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    const entity = toNormalizedEntity(company);
    expect(entity.registryRecord).toMatchObject({
      availability: "available",
      value: { section: "Sro", idNumber: "3586" },
    });
    expect(entity.shareCapital).toMatchObject({
      availability: "available",
      value: { text: "140 000 EUR" },
    });
    expect(entity.shareCapitalPaid).toMatchObject({
      availability: "available",
      value: { text: "140 000 EUR" },
    });
    expect(entity.actingClause).toMatchObject({
      availability: "available",
    });
    if (entity.actingClause.availability === "available") {
      expect(entity.actingClause.value).toContain("V mene spoločnosti");
    }
    if (entity.keyPeople.availability === "available") {
      expect(
        entity.keyPeople.value.some((group) => group.name === "Spoločníci"),
      ).toBe(true);
    }
    expect(entity.registrationDate).toEqual({
      availability: "not-supported",
    });
  });

  test("projects search rows without inventing unavailable status", () => {
    const result = toNormalizedSearchResult({
      ico: "31333532",
      name: "ESET, spol. s r.o.",
      address: "Einsteinova 24, Bratislava",
    });
    expect(result.status).toEqual({ availability: "not-supported" });
  });
});
