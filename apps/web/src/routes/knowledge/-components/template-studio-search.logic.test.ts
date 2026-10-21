import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { isSafeFieldPath } from "@stll/template-conditions";

import { sanitizeFieldPath } from "@/routes/knowledge/-components/template-studio-model";
import type { StudioField } from "@/routes/knowledge/-components/template-studio-store";

import {
  buildSlashRootItems,
  filterTemplateTagSuggestions,
  matchingSlashFields,
  type SlashRootItem,
} from "./template-studio-search.logic";

const PROPERTY_MAX_TEXT_PARTS = 20;
const PROPERTY_MAX_TAGS = 12;
const OLD_SLASH_MENU_MAX_FIELDS = 50;
const OLD_MAX_TAG_SUGGESTIONS = 6;
const PROPERTY_EXTRA_FIELDS = 10;
const PROPERTY_MAX_FIELDS = OLD_SLASH_MENU_MAX_FIELDS + PROPERTY_EXTRA_FIELDS;
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

const field = (path: string, label = ""): StudioField => ({
  aiAdapt: false,
  aiPrompt: undefined,
  aiSeesDocument: false,
  inputType: "text",
  kind: "string",
  label,
  options: [],
  path,
  required: false,
  valueSource: { type: "input" },
});

const oldMatchingSlashFields = (
  query: string,
  fields: StudioField[],
): StudioField[] => {
  const needle = query.trim().toLowerCase().toWellFormed();
  const matches = (candidate: StudioField): boolean => {
    if (needle === "") {
      return true;
    }
    const label = candidate.label === "" ? candidate.path : candidate.label;
    return (
      candidate.path.toLowerCase().toWellFormed().includes(needle) ||
      label.toLowerCase().toWellFormed().includes(needle)
    );
  };
  return fields.filter(matches).slice(0, OLD_SLASH_MENU_MAX_FIELDS);
};

const oldCreateFieldPathFromQuery = (trimmed: string): string => {
  if (trimmed === "") {
    return "field";
  }
  if (isSafeFieldPath(trimmed)) {
    return trimmed;
  }
  const sanitized = sanitizeFieldPath(trimmed);
  return isSafeFieldPath(sanitized) ? sanitized : "field";
};

const oldUniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((candidate) => candidate.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

const oldBuildSlashRootItems = (
  query: string,
  fields: StudioField[],
): SlashRootItem[] => {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase().toWellFormed();
  const matches = (...keywords: string[]): boolean =>
    keywords.some((keyword) => keyword.toWellFormed().includes(needle));
  if (trimmed === "") {
    const items: SlashRootItem[] = [
      { kind: "create-field", path: oldUniqueFieldPath("field", fields) },
      { kind: "create-condition" },
    ];
    if (fields.length > 0) {
      items.push({ kind: "open-fields" });
    }
    items.push({ kind: "open-clauses" });
    return items;
  }
  const createPath = oldCreateFieldPathFromQuery(trimmed);
  const reuseExact = fields.some((candidate) => candidate.path === createPath);
  const items: SlashRootItem[] = oldMatchingSlashFields(query, fields).map(
    (candidate) => ({
      kind: "field",
      path: candidate.path,
      label: candidate.label === "" ? candidate.path : candidate.label,
    }),
  );
  if (matches("clause")) {
    items.push({ kind: "open-clauses" });
  }
  if (matches("condition", "if")) {
    items.push({ kind: "create-condition" });
  }
  if (!reuseExact) {
    items.push({ kind: "create-field", path: createPath });
  }
  return items;
};

describe("template studio slash search", () => {
  test("blank root queries preserve the action order and uniquify the field path", () => {
    expect(buildSlashRootItems("  ", [])).toEqual([
      { kind: "create-field", path: "field" },
      { kind: "create-condition" },
      { kind: "open-clauses" },
    ]);
    expect(buildSlashRootItems("", [field("field")])).toEqual([
      { kind: "create-field", path: "field_2" },
      { kind: "create-condition" },
      { kind: "open-fields" },
      { kind: "open-clauses" },
    ]);
  });

  test("matches trimmed case-insensitive path and label substrings in source order, capped at 50", () => {
    const fields = [field("first", "Clause target"), field("clause_path")];
    expect(matchingSlashFields(" CLAUSE ", fields)).toEqual(fields);
    expect(
      matchingSlashFields("cafe", [field("cafe"), field("x", "Café")]),
    ).toEqual([field("cafe")]);
    const capped = Array.from({ length: 55 }, (_, index) =>
      field(`target_${index}`),
    );
    expect(matchingSlashFields("target", capped)).toEqual(capped.slice(0, 50));
  });

  test("root actions follow keyword order and reuse an exact derived path", () => {
    expect(buildSlashRootItems("cla", [])).toEqual([
      { kind: "open-clauses" },
      { kind: "create-field", path: "cla" },
    ]);
    expect(buildSlashRootItems("condition", [])).toEqual([
      { kind: "create-condition" },
      { kind: "create-field", path: "condition" },
    ]);
    expect(buildSlashRootItems("case_number", [field("case_number")])).toEqual([
      { kind: "field", path: "case_number", label: "case_number" },
    ]);
  });

  test("slash search matches malformed surrogates as replacement characters and rejects half-astral queries", () => {
    expect(matchingSlashFields("\ufffd", [field("broken\ud800text")])).toEqual([
      field("broken\ud800text"),
    ]);
    expect(matchingSlashFields("\ud83d", [field("😀")])).toEqual([]);
    expect(matchingSlashFields("\ude00", [field("😀")])).toEqual([]);
  });

  test("template studio menu outputs match the previous substring algorithms for generated Unicode inputs", () => {
    const generatedFields = fc
      .array(
        fc.record({ path: searchTextArbitrary, label: searchTextArbitrary }),
        { maxLength: PROPERTY_MAX_FIELDS },
      )
      .map((fields) => fields.map(({ path, label }) => field(path, label)));
    assertProperty(
      "template studio menu outputs match the previous substring algorithms for generated Unicode inputs",
      fc.property(generatedFields, searchTextArbitrary, (fields, query) => {
        expect(matchingSlashFields(query, fields)).toEqual(
          oldMatchingSlashFields(query, fields),
        );
        expect(buildSlashRootItems(query, fields)).toEqual(
          oldBuildSlashRootItems(query, fields),
        );
      }),
    );
  });
});

describe("template tag suggestions", () => {
  test("trims and lowercases the query, excludes selected tags, preserves order, and caps at six", () => {
    const suggestions = ["contracts", "Contract review", "corporate"];
    expect(
      filterTemplateTagSuggestions(suggestions, ["contracts"], "  CON "),
    ).toEqual(["Contract review"]);
    expect(
      filterTemplateTagSuggestions(["a", "b", "c", "d", "e", "f", "g"], [], ""),
    ).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(filterTemplateTagSuggestions(["Café", "cafe"], [], "cafe")).toEqual([
      "cafe",
    ]);
    expect(filterTemplateTagSuggestions(["A+B", "AB"], [], "+")).toEqual([
      "A+B",
    ]);
  });

  test("tag suggestions match the previous predicate and cap for generated Unicode inputs", () => {
    assertProperty(
      "tag suggestions match the previous predicate and cap for generated Unicode inputs",
      fc.property(
        fc.array(searchTextArbitrary, { maxLength: PROPERTY_MAX_TAGS }),
        fc.array(searchTextArbitrary, { maxLength: PROPERTY_MAX_TAGS }),
        searchTextArbitrary,
        (suggestions, tags, input) => {
          const expected = suggestions
            .filter(
              (tag) =>
                !tags.includes(tag) &&
                tag
                  .toLowerCase()
                  .toWellFormed()
                  .includes(input.trim().toLowerCase().toWellFormed()),
            )
            .slice(0, OLD_MAX_TAG_SUGGESTIONS);
          expect(
            filterTemplateTagSuggestions(suggestions, tags, input),
          ).toEqual(expected);
        },
      ),
    );
  });
});
