import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { compareByLocale } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterOnboardingCatalogueEntries } from "./catalogue-search.logic";

const PROPERTY_MAX_TEXT_PARTS = 20;
const PROPERTY_MAX_ENTRIES = 12;
const PROPERTY_MAX_METADATA_VALUES = 5;
const searchTextArbitrary = fc
  .array(
    fc.constantFrom(
      "a",
      "C",
      "é",
      "e\u0301",
      "Č",
      "c\u030C",
      "ß",
      "ς",
      "😀",
      "\ud800",
      "\udc00",
      "\ufffd",
      "+",
      "[",
      " ",
      "\t",
    ),
    { maxLength: PROPERTY_MAX_TEXT_PARTS },
  )
  .map((parts) => parts.join(""));
const compareName = compareByLocale("en");

const matchesFolded = (field: string, query: string) =>
  foldSearchMatchText(field.toWellFormed()).includes(
    foldSearchMatchText(query.trim().toWellFormed()),
  );

const recommended = [
  {
    description: "A legal research tool",
    displayName: "Český search",
    jurisdictions: ["CZ"],
    slug: "recommended",
    tags: ["law"],
  },
];
const others = [
  {
    description: "Review contracts",
    displayName: "Contract review",
    jurisdictions: ["US"],
    slug: "other",
    tags: ["contract"],
  },
  {
    description: "Universal support",
    displayName: "Universal",
    jurisdictions: [],
    slug: "universal",
    tags: ["support"],
  },
];

const filter = (query: string, jurisdictionFilter = new Set<string>()) =>
  filterOnboardingCatalogueEntries({
    compareName,
    jurisdictionFilter,
    localizedName: (entry) => entry.slug,
    otherEntries: others,
    query,
    recommendedEntries: recommended,
  });

describe("onboarding catalogue filtering", () => {
  test("matches trimmed substrings across display name, description, and tags", () => {
    expect(filter("  LEGAL ").map(({ slug }) => slug)).toEqual(["recommended"]);
    expect(filter("contract").map(({ slug }) => slug)).toEqual(["other"]);
    expect(filter("support").map(({ slug }) => slug)).toEqual(["universal"]);
  });

  test("blank search keeps entries; jurisdiction scopes preserve universal entries", () => {
    expect(filter(" ").map(({ slug }) => slug)).toEqual([
      "other",
      "recommended",
      "universal",
    ]);
    expect(filter("", new Set(["CZ"])).map(({ slug }) => slug)).toEqual([
      "recommended",
      "universal",
    ]);
  });

  test("keeps punctuation literal while ignoring case and accents", () => {
    expect(
      filterOnboardingCatalogueEntries({
        compareName,
        jurisdictionFilter: new Set(),
        localizedName: (entry) => entry.displayName,
        otherEntries: [
          {
            description: "Punctuation A+B",
            displayName: "Literal",
            jurisdictions: [],
            tags: [],
          },
          {
            description: "Café tool",
            displayName: "Accent",
            jurisdictions: [],
            tags: [],
          },
        ],
        query: "+",
        recommendedEntries: [],
      }).map(({ displayName }) => displayName),
    ).toEqual(["Literal"]);
    expect(filter("cesky").map(({ slug }) => slug)).toEqual(["recommended"]);
    expect(filter("ČESKÝ").map(({ slug }) => slug)).toEqual(["recommended"]);
  });

  test("matches malformed surrogates as replacement characters and rejects half-astral queries", () => {
    const malformedEntries = [
      {
        description: "broken\udc00text",
        displayName: "",
        jurisdictions: [],
        slug: "malformed",
        tags: [],
      },
    ];
    const astralEntries = [
      {
        description: "😀",
        displayName: "",
        jurisdictions: [],
        slug: "astral",
        tags: [],
      },
    ];
    const filterEntries = (source: typeof malformedEntries, query: string) =>
      filterOnboardingCatalogueEntries({
        compareName,
        jurisdictionFilter: new Set(),
        localizedName: (entry) => entry.slug,
        otherEntries: source,
        query,
        recommendedEntries: [],
      });
    expect(filterEntries(malformedEntries, "\ufffd")).toEqual(malformedEntries);
    expect(filterEntries(astralEntries, "\ud83d")).toEqual([]);
    expect(filterEntries(astralEntries, "\ude00")).toEqual([]);
  });

  test("onboarding catalogue filtering keeps exactly the folded matches for generated Unicode inputs", () => {
    assertProperty(
      "onboarding catalogue filtering keeps exactly the folded matches for generated Unicode inputs",
      fc.property(
        fc.array(
          fc.record({
            description: searchTextArbitrary,
            displayName: searchTextArbitrary,
            jurisdictions: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
            localizedName: searchTextArbitrary,
            slug: searchTextArbitrary,
            tags: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
          }),
          { maxLength: PROPERTY_MAX_ENTRIES },
        ),
        fc.array(
          fc.record({
            description: searchTextArbitrary,
            displayName: searchTextArbitrary,
            jurisdictions: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
            localizedName: searchTextArbitrary,
            slug: searchTextArbitrary,
            tags: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
          }),
          { maxLength: PROPERTY_MAX_ENTRIES },
        ),
        searchTextArbitrary,
        fc.array(searchTextArbitrary, {
          maxLength: PROPERTY_MAX_METADATA_VALUES,
        }),
        (recommendedEntries, otherEntries, query, jurisdictionCodes) => {
          const localizedName = (entry: (typeof recommendedEntries)[number]) =>
            entry.localizedName;
          const jurisdictionFilter = new Set(jurisdictionCodes);
          const matchesSearch = (
            entry: (typeof recommendedEntries)[number],
          ) => {
            if (jurisdictionFilter.size > 0 && entry.jurisdictions.length > 0) {
              const hasMatch = entry.jurisdictions.some((code) =>
                jurisdictionFilter.has(code),
              );
              if (!hasMatch) {
                return false;
              }
            }
            return (
              matchesFolded(entry.displayName, query) ||
              matchesFolded(localizedName(entry), query) ||
              matchesFolded(entry.description, query) ||
              entry.tags.some((tag) => matchesFolded(tag, query))
            );
          };
          const expected = [...recommendedEntries, ...otherEntries]
            .filter(matchesSearch)
            .toSorted((left, right) =>
              compareName(localizedName(left), localizedName(right)),
            );
          expect(
            filterOnboardingCatalogueEntries({
              compareName,
              jurisdictionFilter,
              localizedName,
              otherEntries,
              query,
              recommendedEntries,
            }),
          ).toEqual(expected);
        },
      ),
    );
  });
});
