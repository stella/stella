import { describe, expect, test } from "bun:test";

import fixture from "./__fixtures__/lookup-siren-renault.json" with { type: "json" };
import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type { RechercheEntreprisesSearchResponse } from "./types.js";

// SAFETY: captured official fixture is consumed by the defensive parser.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const raw = fixture as unknown as RechercheEntreprisesSearchResponse;

describe("French registry normalized projection", () => {
  test("preserves SIRET aliases, legal-form code, address, and directors", () => {
    const source = raw.results[0];
    expect(source).toBeDefined();
    if (!source) {
      return;
    }
    const entity = toNormalizedEntity(parseCompany(source));
    expect(entity.registryId.scheme).toBe("FR-SIREN");
    expect(entity.identifiers.some((item) => item.scheme === "FR-SIRET")).toBe(
      true,
    );
    expect(entity.legalForm).toMatchObject({ availability: "available" });
    if (entity.legalForm.availability === "available") {
      expect(entity.legalForm.value?.code).not.toBeNull();
    }
    if (entity.address.availability === "available") {
      expect(entity.address.value?.textAddress).not.toBeNull();
    }
    if (entity.keyPeople.availability === "available") {
      expect(entity.keyPeople.value[0]?.people.length).toBeGreaterThan(0);
    }
    expect(entity.warnings).toEqual({ availability: "not-supported" });
  });

  test("declares fields absent from the thin search domain", () => {
    const source = raw.results[0];
    expect(source).toBeDefined();
    if (!source) {
      return;
    }
    const result = toNormalizedSearchResult(parseSearchEntry(source));
    expect(result.status).toEqual({ availability: "not-supported" });
    expect(result.registryUrl).toEqual({ availability: "not-supported" });
  });
});
