import { describe, expect, test } from "bun:test";

import type { ResolvedField } from "@/api/lib/docx/types";

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
        label: "Company name",
        hint: null,
        inputType: "text",
        options: null,
        dateFormat: null,
      },
      {
        id: "f2",
        path: "signing_date",
        label: null,
        hint: null,
        inputType: "date",
        options: null,
        dateFormat: null,
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

  test("includes the field's fill hint when set", () => {
    const rendered = renderPrefillTargets(
      buildPrefillTargets([
        field({
          path: "company.krs",
          label: "KRS number",
          hint: "10-digit number from the register",
        }),
      ]),
    );
    expect(rendered).toBe(
      'f1: company.krs — "KRS number" (text) — hint: "10-digit number from the register"',
    );
  });
});

describe("mapPrefillResults", () => {
  const targets = buildPrefillTargets([
    field({ path: "company.name" }),
    field({ path: "court", inputType: "select", options: ["Praha", "Brno"] }),
    field({ path: "is_signed", kind: "boolean" }),
    field({ path: "seat" }),
  ]);

  test("maps ids back to the paths they stand for", () => {
    const suggestions = mapPrefillResults(targets, [
      { id: "f1", value: "Acme s.r.o.", sourceSnippet: "Acme s.r.o., IČO" },
      { id: "f4", value: "Praha", sourceSnippet: null },
    ]);

    expect(suggestions).toEqual([
      {
        path: "company.name",
        value: "Acme s.r.o.",
        sourceSnippet: "Acme s.r.o., IČO",
      },
      { path: "seat", value: "Praha", sourceSnippet: null },
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
      { path: "court", value: "Praha", sourceSnippet: null },
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
    ).toEqual([{ path: "is_signed", value: "true", sourceSnippet: null }]);

    expect(
      mapPrefillResults(targets, [
        { id: "f3", value: "maybe", sourceSnippet: null },
      ]),
    ).toEqual([]);
  });

  test("a date is read in the locale the field renders it in", () => {
    const dateTargets = buildPrefillTargets([
      field({
        path: "signing_date",
        inputType: "date",
        dateFormat: { locale: "cs", style: "long" },
      }),
      field({ path: "filed_on", inputType: "date" }),
    ]);

    expect(
      mapPrefillResults(dateTargets, [
        { id: "f1", value: "1. října 2026", sourceSnippet: null },
      ]),
    ).toEqual([
      {
        path: "signing_date",
        value: "2026-10-01",
        sourceSnippet: null,
      },
    ]);

    // A field with no format of its own reads English alone, so a Czech month
    // name is not a suggestion it can offer.
    expect(
      mapPrefillResults(dateTargets, [
        { id: "f2", value: "1. října 2026", sourceSnippet: null },
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
