import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  CASE_LAW_INDEX_GROUP_NAMES,
  CASE_LAW_INDEX_GROUP_OF,
  CASE_LAW_INDEX_GROUPING_FROM_GENERATION,
  CASE_LAW_INDEX_GROUPS,
} from "@/api/lib/legal-search/case-law-index-groups";
import {
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_ID_MAX_LENGTH,
  caseLawCorpusGenerationOrder,
  corpusIndexGeneration,
  corpusIndexId,
  corpusIndexIdsFor,
  corpusIndexJurisdictions,
  corpusIndexPattern,
  corpusIndexRoute,
  isCaseLawCorpusGeneration,
  tryCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";

test("index id is the generation prefix + lowercased jurisdiction", () => {
  expect(corpusIndexId("case_law_v1", "SVK")).toBe("case_law_v1_svk");
  expect(corpusIndexId("case_law_v2", "CZE")).toBe("case_law_v2_cze");
  expect(corpusIndexId("legislation_v1", "cze")).toBe("legislation_v1_cze");
});

test("case-law ids are per index group from the grouping generation on", () => {
  expect(CASE_LAW_INDEX_GROUPING_FROM_GENERATION).toBe(3);
  for (const [country, group] of Object.entries(CASE_LAW_INDEX_GROUP_OF)) {
    expect(corpusIndexId("case_law_v3", country)).toBe(`case_law_v3_${group}`);
    expect(corpusIndexId("case_law_v12", country.toLowerCase())).toBe(
      `case_law_v12_${group}`,
    );
    // Grouping is a rule about the case-law family's generations only.
    expect(corpusIndexId("case_law_v2", country)).toBe(
      `case_law_v2_${country.toLowerCase()}`,
    );
    expect(corpusIndexId("legislation_v3", country)).toBe(
      `legislation_v3_${country.toLowerCase()}`,
    );
  }
  // Non-vacuity: at least one group is shared, and it is named apart from
  // any one member's code.
  expect(corpusIndexId("case_law_v3", "CZE")).toBe("case_law_v3_cs_sk");
  expect(corpusIndexId("case_law_v3", "SVK")).toBe("case_law_v3_cs_sk");
  // A country outside every group is its own group.
  expect(corpusIndexId("case_law_v3", "HUN")).toBe("case_law_v3_hun");
});

test("a country outside the declaration never lands in a declared group", () => {
  // The DB accepts any 2-8 letter code, so a code whose lowercase form is a
  // group name would share that group's index without being a member. Group
  // names are a member's own code or contain a separator no code holds, so
  // every code outside the declaration derives an index that is its own.
  for (const group of CASE_LAW_INDEX_GROUP_NAMES) {
    const members = CASE_LAW_INDEX_GROUPS.get(group) ?? [];
    expect(members.length).toBeGreaterThan(0);
    const selfNamed = members.some((member) => member.toLowerCase() === group);
    expect([group, selfNamed || group.includes("_")]).toEqual([group, true]);
  }
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z]{2,8}$/u), (code) => {
      const indexId = corpusIndexId("case_law_v3", code);
      const declared = Object.hasOwn(
        CASE_LAW_INDEX_GROUP_OF,
        code.toUpperCase(),
      );
      // Codes off the declaration derive their own index, one no declared
      // group answers for.
      if (!declared) {
        expect(indexId).toBe(`case_law_v3_${code.toLowerCase()}`);
        expect(corpusIndexJurisdictions("case_law_v3", indexId)).toEqual([
          code.toUpperCase(),
        ]);
      }
    }),
    propertyConfig({ numRuns: 300 }),
  );
  // The concrete near-miss: a two-letter code equal to a language tag.
  expect(corpusIndexId("case_law_v3", "PL")).toBe("case_law_v3_pl");
  expect(corpusIndexId("case_law_v3", "PL")).not.toBe(
    corpusIndexId("case_law_v3", "POL"),
  );
});

test("the jurisdictions of an index are the inverse of its derivation", () => {
  const generationPattern = new RegExp(
    `^[a-z][a-z0-9_]{0,${CORPUS_INDEX_GENERATION_MAX_LENGTH - 1}}$`,
    "u",
  );
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom("case_law_v2", "case_law_v3", "legislation_v1"),
        fc.stringMatching(generationPattern),
      ),
      fc.stringMatching(/^[A-Za-z]{2,8}$/u),
      (generation, jurisdiction) => {
        const indexId = corpusIndexId(generation, jurisdiction);
        const held = corpusIndexJurisdictions(generation, indexId);
        // Every jurisdiction the index is said to hold derives to it, and the
        // one it was derived from is among them.
        expect(held).toContain(jurisdiction.toUpperCase());
        for (const country of held) {
          expect(corpusIndexId(generation, country)).toBe(indexId);
        }
      },
    ),
    propertyConfig({ numRuns: 300 }),
  );
  expect(corpusIndexJurisdictions("case_law_v3", "case_law_v3_cs_sk")).toEqual([
    "CZE",
    "SVK",
  ]);
  expect(corpusIndexJurisdictions("case_law_v2", "case_law_v2_cze")).toEqual([
    "CZE",
  ]);
  expect(() =>
    corpusIndexJurisdictions("case_law_v2", "case_law_v3_cze"),
  ).toThrow("is not of generation case_law_v2");
});

test("distinct physical ids for a jurisdiction list", () => {
  expect(corpusIndexIdsFor("case_law_v3", ["CZE", "POL", "SVK"])).toEqual([
    "case_law_v3_cs_sk",
    "case_law_v3_pol",
  ]);
  expect(corpusIndexIdsFor("case_law_v2", ["CZE", "POL", "SVK"])).toEqual([
    "case_law_v2_cze",
    "case_law_v2_pol",
    "case_law_v2_svk",
  ]);
});

test("a scoped query names its index, and a clause only where the index is shared", () => {
  // Shared index: the clause keeps the query to the scoped jurisdiction.
  expect(corpusIndexRoute("case_law_v3", "CZE")).toEqual({
    indexId: "case_law_v3_cs_sk",
    jurisdictionClause: "CZE",
  });
  // The clause is the canonical code indexed documents carry, whatever
  // case the scope arrived in.
  expect(corpusIndexRoute("case_law_v3", "cze")).toEqual({
    indexId: "case_law_v3_cs_sk",
    jurisdictionClause: "CZE",
  });
  // A single-country group is bounded by its index alone.
  expect(corpusIndexRoute("case_law_v3", "POL")).toEqual({
    indexId: "case_law_v3_pol",
    jurisdictionClause: undefined,
  });
  // Before grouping every index is one jurisdiction's.
  expect(corpusIndexRoute("case_law_v2", "CZE")).toEqual({
    indexId: "case_law_v2_cze",
    jurisdictionClause: undefined,
  });
  expect(corpusIndexRoute("case_law_v3", undefined)).toEqual({
    indexId: "case_law_v3_*",
    jurisdictionClause: undefined,
  });
});

test("pattern globs all jurisdiction indexes for a generation", () => {
  expect(corpusIndexPattern("case_law_v1")).toBe("case_law_v1_*");
  expect(corpusIndexPattern("legislation_v1")).toBe("legislation_v1_*");
});

test("rejects a non-alpha jurisdiction (guards against odd index ids)", () => {
  expect(() => corpusIndexId("case_law_v1", "sk droptable")).toThrow(
    "Invalid jurisdiction for corpus index index id: sk droptable",
  );
  expect(() => corpusIndexId("case_law_v1", "")).toThrow(
    "Invalid jurisdiction for corpus index index id: ",
  );
  expect(() => corpusIndexId("case_law_v1", "sk-1")).toThrow(
    "Invalid jurisdiction for corpus index index id: sk-1",
  );
});

test("rejects generations outside the shared storage contract", () => {
  expect(() => corpusIndexId("", "svk")).toThrow(
    "Invalid corpus index generation: ",
  );
  expect(() => corpusIndexId("1_case_law", "svk")).toThrow(
    "Invalid corpus index generation: 1_case_law",
  );
  expect(() =>
    corpusIndexId("x".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH + 1), "svk"),
  ).toThrow("Invalid corpus index generation:");
  expect(() => corpusIndexPattern("case law v1")).toThrow(
    "Invalid corpus index generation: case law v1",
  );
});

test("case-law generation order is canonical and total over its domain", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), (order) => {
      const generation = `case_law_v${order}`;
      expect(isCaseLawCorpusGeneration(generation)).toBe(true);
      expect(caseLawCorpusGenerationOrder(generation)).toBe(order);
    }),
    propertyConfig({ numRuns: 200 }),
  );
  for (const invalid of [
    "case_law_v0",
    "case_law_v01",
    "case_law_v2_suffix",
    "legislation_v2",
    "case_law_v2147483648",
  ]) {
    expect(isCaseLawCorpusGeneration(invalid)).toBe(false);
    expect(caseLawCorpusGenerationOrder(invalid)).toBeNull();
  }
});

test("generation extraction is the inverse of index construction", () => {
  const generationPattern = new RegExp(
    `^[a-z][a-z0-9_]{0,${CORPUS_INDEX_GENERATION_MAX_LENGTH - 1}}$`,
    "u",
  );
  fc.assert(
    fc.property(
      fc.stringMatching(generationPattern),
      fc.stringMatching(/^[a-z]{2,8}$/u),
      (generation, jurisdiction) => {
        const indexId = corpusIndexId(generation, jurisdiction);
        expect(indexId.length).toBeLessThanOrEqual(CORPUS_INDEX_ID_MAX_LENGTH);
        expect(corpusIndexGeneration(indexId)).toBe(generation);
      },
    ),
    propertyConfig({ numRuns: 200 }),
  );
});

test("rejects malformed physical index ids", () => {
  expect(() => corpusIndexGeneration("case_law_v1_12")).toThrow(
    "Invalid corpus index index id: case_law_v1_12",
  );
  expect(() => corpusIndexGeneration("svk")).toThrow(
    "Invalid corpus index index id: svk",
  );
  expect(tryCorpusIndexGeneration("case_law_v1")).toBeNull();
  expect(tryCorpusIndexGeneration("case_law_v1_svk")).toBe("case_law_v1");
});

test("generation extraction reads a group suffix that contains the separator", () => {
  for (const generation of ["case_law_v3", "case_law_v12"]) {
    for (const group of CASE_LAW_INDEX_GROUP_NAMES) {
      expect(corpusIndexGeneration(`${generation}_${group}`)).toBe(generation);
    }
    expect(corpusIndexGeneration(`${generation}_hun`)).toBe(generation);
  }
});
