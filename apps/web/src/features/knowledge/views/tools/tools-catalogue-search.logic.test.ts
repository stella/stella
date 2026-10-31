import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { compareByLocale } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterToolsCatalogueEntries } from "./tools-catalogue-search.logic";

const PROPERTY_MAX_TEXT_PARTS = 20;
const PROPERTY_MAX_TOOLS = 12;
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

const entries = [
  {
    description: "Consult the legal source",
    displayName: "Source",
    isRecommendedForOrg: false,
    jurisdictions: ["CZ"],
    kind: "mcp",
    slug: "source",
    tags: ["law"],
  },
  {
    description: "A contract skill",
    displayName: "Skill",
    isRecommendedForOrg: true,
    jurisdictions: ["EU"],
    kind: "skill",
    slug: "skill",
    tags: ["review"],
  },
  {
    description: "Universal source",
    displayName: "Universal",
    isRecommendedForOrg: false,
    jurisdictions: [],
    kind: "mcp",
    slug: "universal",
    tags: ["review"],
  },
] as const;

const filter = (query: string, jurisdictionFilter = new Set<string>()) =>
  filterToolsCatalogueEntries({
    compareName,
    entries,
    filter: "all",
    jurisdictionFilter,
    localizedName: (entry) => entry.displayName,
    query,
  });

describe("knowledge tool catalogue filtering", () => {
  test("trims the query, matches a substring in any supported field, and sorts recommendations first", () => {
    expect(filter("  REVIEW  ").map(({ slug }) => slug)).toEqual([
      "skill",
      "universal",
    ]);
    expect(filter("legal").map(({ slug }) => slug)).toEqual(["source"]);
    expect(filter("law").map(({ slug }) => slug)).toEqual(["source"]);
  });

  test("blank search keeps all entries and jurisdiction filters retain universal entries", () => {
    expect(filter("   ").map(({ slug }) => slug)).toEqual([
      "skill",
      "source",
      "universal",
    ]);
    expect(filter("", new Set(["CZ"])).map(({ slug }) => slug)).toEqual([
      "source",
      "universal",
    ]);
  });

  test("keeps punctuation literal while ignoring case and accents", () => {
    expect(
      filterToolsCatalogueEntries({
        compareName,
        entries: [
          {
            description: "A+B clause",
            displayName: "Punctuation",
            jurisdictions: [],
            kind: "mcp",
            tags: [],
          },
          {
            description: "Café",
            displayName: "Accented",
            jurisdictions: [],
            kind: "mcp",
            tags: [],
          },
        ],
        filter: "all",
        jurisdictionFilter: new Set(),
        localizedName: (entry) => entry.displayName,
        query: "+",
      }).map(({ displayName }) => displayName),
    ).toEqual(["Punctuation"]);
    expect(
      filterToolsCatalogueEntries({
        compareName,
        entries: [
          {
            description: "Café Straße",
            displayName: "Accented",
            jurisdictions: [],
            kind: "mcp",
            tags: [],
          },
        ],
        filter: "all",
        jurisdictionFilter: new Set(),
        localizedName: (entry) => entry.displayName,
        query: "cafe strasse",
      }).map(({ displayName }) => displayName),
    ).toEqual(["Accented"]);
  });

  test("matches malformed surrogates as replacement characters and rejects half-astral queries", () => {
    const malformedEntries = [
      {
        description: "",
        displayName: "broken\ud800text",
        jurisdictions: [],
        kind: "mcp",
        tags: [],
      },
    ];
    const astralEntries = [
      {
        description: "",
        displayName: "😀",
        jurisdictions: [],
        kind: "mcp",
        tags: [],
      },
    ];
    const filterEntries = (source: typeof malformedEntries, query: string) =>
      filterToolsCatalogueEntries({
        compareName,
        entries: source,
        filter: "all",
        jurisdictionFilter: new Set(),
        localizedName: (entry) => entry.displayName,
        query,
      });
    expect(filterEntries(malformedEntries, "\ufffd")).toEqual(malformedEntries);
    expect(filterEntries(astralEntries, "\ud83d")).toEqual([]);
    expect(filterEntries(astralEntries, "\ude00")).toEqual([]);
  });

  test("knowledge tool filtering keeps exactly the folded matches for generated Unicode inputs", () => {
    assertProperty(
      "knowledge tool filtering keeps exactly the folded matches for generated Unicode inputs",
      fc.property(
        fc.array(
          fc.record({
            description: searchTextArbitrary,
            displayName: searchTextArbitrary,
            isRecommendedForOrg: fc.oneof(fc.constant(undefined), fc.boolean()),
            jurisdictions: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
            kind: fc.constantFrom("skill", "mcp"),
            localizedName: searchTextArbitrary,
            slug: searchTextArbitrary,
            tags: fc.array(searchTextArbitrary, {
              maxLength: PROPERTY_MAX_METADATA_VALUES,
            }),
          }),
          { maxLength: PROPERTY_MAX_TOOLS },
        ),
        fc.constantFrom("all", "skill", "mcp"),
        searchTextArbitrary,
        fc.array(searchTextArbitrary, {
          maxLength: PROPERTY_MAX_METADATA_VALUES,
        }),
        (generatedEntries, filterKind, query, jurisdictionCodes) => {
          const localizedName = (entry: (typeof generatedEntries)[number]) =>
            entry.localizedName;
          const jurisdictionFilter = new Set(jurisdictionCodes);
          const subset = generatedEntries.filter((entry) => {
            if (filterKind !== "all" && entry.kind !== filterKind) {
              return false;
            }
            if (
              jurisdictionFilter.size > 0 &&
              entry.jurisdictions.length > 0 &&
              !entry.jurisdictions.some((code) => jurisdictionFilter.has(code))
            ) {
              return false;
            }
            return (
              matchesFolded(entry.displayName, query) ||
              matchesFolded(localizedName(entry), query) ||
              matchesFolded(entry.description, query) ||
              entry.tags.some((tag) => matchesFolded(tag, query))
            );
          });
          const expected = [...subset].toSorted((left, right) => {
            if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
              return left.isRecommendedForOrg ? -1 : 1;
            }
            return compareName(localizedName(left), localizedName(right));
          });
          expect(
            filterToolsCatalogueEntries({
              compareName,
              entries: generatedEntries,
              filter: filterKind,
              jurisdictionFilter,
              localizedName,
              query,
            }),
          ).toEqual(expected);
        },
      ),
    );
  });
});
