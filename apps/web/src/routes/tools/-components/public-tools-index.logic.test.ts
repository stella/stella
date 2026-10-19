import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import type { PublicToolBrowseEntry } from "@/routes/tools/-components/public-tools-index.logic";
import {
  filterPublicToolEntries,
  groupPublicToolEntries,
} from "@/routes/tools/-components/public-tools-index.logic";

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
const practiceAreaArbitrary = fc.constantFrom(
  "corporate",
  "litigation",
  "commercial",
  "employment",
);
const publicToolEntriesArbitrary = fc
  .array(
    fc.record({
      author: searchTextArbitrary,
      description: searchTextArbitrary,
      displayName: searchTextArbitrary,
      jurisdictions: fc.array(searchTextArbitrary, {
        maxLength: PROPERTY_MAX_METADATA_VALUES,
      }),
      kind: fc.constantFrom("skill", "native-tool"),
      slug: searchTextArbitrary,
      tags: fc.array(practiceAreaArbitrary, {
        maxLength: PROPERTY_MAX_METADATA_VALUES,
      }),
    }),
    { maxLength: PROPERTY_MAX_TOOLS },
  )
  .map((generated) => generated.map((overrides) => entry(overrides)));

const entry = (
  overrides: Partial<PublicToolBrowseEntry> &
    Pick<PublicToolBrowseEntry, "kind" | "slug">,
): PublicToolBrowseEntry => ({
  author: "stella",
  description: "",
  displayName: overrides.slug,
  jurisdictions: [],
  tags: [],
  ...overrides,
});

const skillEntry = entry({
  author: "Adrián Lerer",
  description: "Argentine citation analysis",
  displayName: "JurisRank",
  jurisdictions: ["AR"],
  kind: "skill",
  slug: "jurisrank",
  tags: ["litigation"],
});
const dataSourceEntry = entry({
  displayName: "Companies House",
  jurisdictions: ["GB"],
  kind: "native-tool",
  slug: "companies-house",
  tags: ["corporate"],
});
const includedEntry = entry({
  displayName: "Create DOCX",
  kind: "native-tool",
  pinned: true,
  slug: "create-docx",
});
const entries = [skillEntry, dataSourceEntry, includedEntry];

const noFilters = {
  jurisdictions: new Set<string>(),
  kind: "all" as const,
  query: "",
  tags: new Set<string>(),
  task: null,
};

describe("filterPublicToolEntries", () => {
  test("searches names, descriptions, authors, and metadata without accents", () => {
    expect(
      filterPublicToolEntries(entries, { ...noFilters, query: "adrian AR" }),
    ).toEqual([skillEntry]);
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        query: "corporate house",
      }),
    ).toEqual([dataSourceEntry]);
  });

  test("requires every folded query word, keeps punctuation literal, and accepts blank input", () => {
    expect(
      filterPublicToolEntries(entries, { ...noFilters, query: "   " }),
    ).toEqual(entries);
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        query: "corporate +",
      }),
    ).toEqual([]);
    expect(
      filterPublicToolEntries(
        [entry({ description: "A+B clause", kind: "skill", slug: "plus" })],
        { ...noFilters, query: "+" },
      ).map(({ slug }) => slug),
    ).toEqual(["plus"]);
  });

  test("matches malformed surrogates as replacement characters and rejects half-astral queries", () => {
    expect(
      filterPublicToolEntries(
        [
          entry({
            description: "broken\ud800text",
            kind: "skill",
            slug: "broken",
          }),
        ],
        { ...noFilters, query: "\ufffd" },
      ),
    ).toHaveLength(1);
    const astral = [
      entry({ displayName: "😀", kind: "skill", slug: "astral" }),
    ];
    expect(
      filterPublicToolEntries(astral, { ...noFilters, query: "\ud83d" }),
    ).toEqual([]);
    expect(
      filterPublicToolEntries(astral, { ...noFilters, query: "\ude00" }),
    ).toEqual([]);
  });

  test("public tool filtering matches the previous folded-word predicate for generated Unicode inputs", () => {
    assertProperty(
      "public tool filtering matches the previous folded-word predicate for generated Unicode inputs",
      fc.property(
        publicToolEntriesArbitrary,
        searchTextArbitrary,
        (generatedEntries, query) => {
          const matchesOld = (tool: PublicToolBrowseEntry) => {
            const terms = foldSearchMatchText(query)
              .trim()
              .split(/\s+/u)
              .filter(Boolean)
              .map((term) => term.toWellFormed());
            if (terms.length === 0) {
              return true;
            }
            const haystack = foldSearchMatchText(
              [
                tool.displayName,
                tool.description,
                tool.author ?? "",
                tool.slug,
                ...tool.tags,
                ...tool.jurisdictions,
              ].join(" "),
            ).toWellFormed();
            return terms.every((term) => haystack.includes(term));
          };
          expect(
            filterPublicToolEntries(generatedEntries, { ...noFilters, query }),
          ).toEqual(generatedEntries.filter(matchesOld));
        },
      ),
    );
  });

  test("maps task-led discovery to the relevant catalogue entries", () => {
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        task: "verify-organizations",
      }),
    ).toEqual([dataSourceEntry]);
    expect(
      filterPublicToolEntries(entries, {
        ...noFilters,
        task: "prepare-documents",
      }),
    ).toEqual([includedEntry]);
  });
});

describe("groupPublicToolEntries", () => {
  test("keeps skills, external sources, and included capabilities distinct", () => {
    expect(groupPublicToolEntries(entries)).toEqual({
      skills: [skillEntry],
      "data-sources": [dataSourceEntry],
      included: [includedEntry],
    });
  });
});
