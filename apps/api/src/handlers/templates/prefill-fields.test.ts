import { describe, expect, test } from "bun:test";

import type { ResolvedField } from "@/api/handlers/docx/types";

import {
  buildPrefillTargets,
  mapPrefillResults,
  renderPrefillTargets,
} from "./prefill-fields";

const field = (overrides: Partial<ResolvedField> & { path: string }) =>
  ({ kind: "string", count: 1, ...overrides }) satisfies ResolvedField;

describe("buildPrefillTargets", () => {
  test("maps scalar fields to sequential simple ids", () => {
    const targets = buildPrefillTargets([
      field({ path: "company.name", label: "Company name" }),
      field({ path: "signing_date", inputType: "date" }),
    ]);

    expect(targets).toEqual([
      {
        id: "f1",
        path: "company.name",
        partKey: null,
        label: "Company name",
        inputType: "text",
        options: null,
      },
      {
        id: "f2",
        path: "signing_date",
        partKey: null,
        label: null,
        inputType: "date",
        options: null,
      },
    ]);
  });

  test("skips formula and array fields but keeps id sequence dense", () => {
    const targets = buildPrefillTargets([
      field({ path: "total", formula: "a + b" }),
      field({
        path: "parties",
        kind: "array",
        itemFields: [field({ path: "name" })],
      }),
      field({ path: "place" }),
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: "f1", path: "place" });
  });

  test("flattens composite fields to one target per part", () => {
    const targets = buildPrefillTargets([
      field({
        path: "seat",
        label: "Registered seat",
        parts: [
          { key: "street", inputType: "text", label: "Street" },
          { key: "city", inputType: "select", options: ["Praha", "Brno"] },
        ],
        format: "{{street}}, {{city}}",
      }),
    ]);

    expect(targets).toEqual([
      {
        id: "f1",
        path: "seat",
        partKey: "street",
        label: "Street",
        inputType: "text",
        options: null,
      },
      {
        id: "f2",
        path: "seat",
        partKey: "city",
        label: "Registered seat (city)",
        inputType: "select",
        options: ["Praha", "Brno"],
      },
    ]);
  });

  test("treats a half-configured composite (no format) as a plain field", () => {
    const targets = buildPrefillTargets([
      field({
        path: "seat",
        parts: [{ key: "street", inputType: "text" }],
      }),
    ]);

    expect(targets).toEqual([
      {
        id: "f1",
        path: "seat",
        partKey: null,
        label: null,
        inputType: "text",
        options: null,
      },
    ]);
  });

  test("boolean kind without explicit inputType becomes a boolean target", () => {
    const targets = buildPrefillTargets([
      field({ path: "is_signed", kind: "boolean" }),
    ]);
    expect(targets[0]?.inputType).toBe("boolean");
  });
});

describe("renderPrefillTargets", () => {
  test("renders one line per target with format hints", () => {
    const rendered = renderPrefillTargets(
      buildPrefillTargets([
        field({ path: "company.name", label: "Company name" }),
        field({ path: "signing_date", inputType: "date" }),
        field({
          path: "court",
          inputType: "select",
          options: ["Praha", "Brno"],
        }),
      ]),
    );

    expect(rendered).toBe(
      [
        'f1: company.name — "Company name" (text)',
        "f2: signing_date (date, ISO 8601 (YYYY-MM-DD))",
        'f3: court (select, one of: "Praha", "Brno")',
      ].join("\n"),
    );
  });

  test("marks composite parts in the path label", () => {
    const rendered = renderPrefillTargets(
      buildPrefillTargets([
        field({
          path: "seat",
          parts: [{ key: "street", inputType: "text" }],
          format: "{{street}}",
        }),
      ]),
    );
    expect(rendered).toContain("seat [part street]");
  });
});

describe("mapPrefillResults", () => {
  const targets = buildPrefillTargets([
    field({ path: "company.name" }),
    field({ path: "court", inputType: "select", options: ["Praha", "Brno"] }),
    field({ path: "is_signed", kind: "boolean" }),
    field({
      path: "seat",
      parts: [{ key: "city", inputType: "text" }],
      format: "{{city}}",
    }),
  ]);

  test("maps ids back to paths and part keys", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f1", value: "Acme s.r.o.", sourceSnippet: "Acme s.r.o., IČO" },
      { id: "f4", value: "Praha", sourceSnippet: null },
    ]);

    expect(suggestions).toEqual([
      {
        path: "company.name",
        partKey: null,
        value: "Acme s.r.o.",
        sourceSnippet: "Acme s.r.o., IČO",
      },
      { path: "seat", partKey: "city", value: "Praha", sourceSnippet: null },
    ]);
  });

  test("drops unknown ids, null values, and blank values", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f99", value: "ghost", sourceSnippet: null },
      { id: "f1", value: null, sourceSnippet: null },
      { id: "f2", value: "   ", sourceSnippet: null },
    ]);
    expect(suggestions).toEqual([]);
  });

  test("select values must match an option (case-insensitive, canonicalized)", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f2", value: "praha", sourceSnippet: null },
    ]);
    expect(suggestions).toEqual([
      { path: "court", partKey: null, value: "Praha", sourceSnippet: null },
    ]);

    expect(
      mapPrefillResults(targets, [
        { id: "f2", value: "Ostrava", sourceSnippet: null },
      ]),
    ).toEqual([]);
  });

  test("boolean values normalize to true/false and reject other words", () => {
    expect(
      mapPrefillResults(targets, [
        { id: "f3", value: "Yes", sourceSnippet: null },
      ]),
    ).toEqual([
      { path: "is_signed", partKey: null, value: "true", sourceSnippet: null },
    ]);

    expect(
      mapPrefillResults(targets, [
        { id: "f3", value: "maybe", sourceSnippet: null },
      ]),
    ).toEqual([]);
  });

  test("only the first answer per id wins", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f1", value: "First", sourceSnippet: null },
      { id: "f1", value: "Second", sourceSnippet: null },
    ]);
    expect(suggestions).toEqual([
      {
        path: "company.name",
        partKey: null,
        value: "First",
        sourceSnippet: null,
      },
    ]);
  });

  test("clamps oversized snippets", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f1", value: "Acme", sourceSnippet: "x".repeat(1000) },
    ]);
    expect(suggestions[0]?.sourceSnippet).toHaveLength(300);
  });
});
