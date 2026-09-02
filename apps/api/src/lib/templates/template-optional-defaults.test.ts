import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  applyOmittedOptionalPlaceholderDefaults,
  collectMissingRequiredFields,
  isMissingRequiredFieldValue,
  isTemplateFieldRequired,
} from "./template-optional-defaults";

const fieldPath = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/u);

describe("optional template placeholder defaults", () => {
  test("defaults exactly omitted optional placeholders and is idempotent", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fieldPath, { maxLength: 30 }),
        fc.dictionary(fieldPath, fc.string()),
        fc.uniqueArray(fieldPath, { maxLength: 30 }),
        fc.uniqueArray(fieldPath, { maxLength: 30 }),
        fc.uniqueArray(fieldPath, { maxLength: 30 }),
        (
          paths,
          submittedValues,
          requiredPaths,
          placeholderPaths,
          derivedPaths,
        ) => {
          const required = new Set(requiredPaths);
          const placeholders = new Set(placeholderPaths);
          const derived = new Set(derivedPaths);
          const fields = paths.map((path) => ({
            path,
            required: required.has(path),
            source: derived.has(path) ? { type: "matter" } : undefined,
          }));
          const first = applyOmittedOptionalPlaceholderDefaults({
            fields,
            placeholderPaths,
            values: submittedValues,
          });

          const expectedDefaulted = paths.filter(
            (path) =>
              !required.has(path) &&
              !derived.has(path) &&
              placeholders.has(path) &&
              submittedValues[path] === undefined,
          );
          expect(first.defaultedPaths).toEqual(expectedDefaulted);
          for (const path of paths) {
            if (submittedValues[path] !== undefined) {
              expect(first.values[path]).toBe(submittedValues[path]);
            } else if (expectedDefaulted.includes(path)) {
              expect(first.values[path]).toBe("");
            } else {
              expect(first.values[path]).toBeUndefined();
            }
          }

          expect(
            applyOmittedOptionalPlaceholderDefaults({
              fields,
              placeholderPaths,
              values: first.values,
            }),
          ).toEqual({ defaultedPaths: [], values: first.values });
        },
      ),
      propertyConfig(),
    );
  });

  test("reads legacy validation.required through one shared rule", () => {
    expect(
      isTemplateFieldRequired({
        path: "legacy",
        validation: { required: true },
      }),
    ).toBe(true);
    expect(
      isTemplateFieldRequired({
        path: "explicit",
        required: false,
        validation: { required: true },
      }),
    ).toBe(false);
  });

  test("never masks an unresolved derived placeholder", () => {
    const derivedFields = [
      { path: "formula", formula: "subtotal * tax" },
      { path: "condition", condition: "amount > 0" },
      { path: "conditionAst", conditionAst: { type: "literal" } },
      { path: "source", source: { type: "matter" } },
    ];

    expect(
      applyOmittedOptionalPlaceholderDefaults({
        fields: derivedFields,
        placeholderPaths: derivedFields.map((field) => field.path),
        values: {},
      }),
    ).toEqual({ defaultedPaths: [], values: {} });
  });
});

describe("isMissingRequiredFieldValue", () => {
  test("flags a required, user-entered field that is absent or empty", () => {
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: {},
      }),
    ).toBe(true);
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: { governing_law: "" },
      }),
    ).toBe(true);
  });

  test("does not flag a required field once a non-empty value is present", () => {
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: { governing_law: "Czech" },
      }),
    ).toBe(false);
  });

  test("does not flag an omitted, non-required field", () => {
    expect(
      isMissingRequiredFieldValue({
        field: { path: "optional_note", required: false },
        values: {},
      }),
    ).toBe(false);
  });

  test("does not flag a required field the fill boundary resolves on its own: AI-fillable, formula, condition, or source", () => {
    const derivedRequiredFields = [
      { path: "ai", required: true, aiPrompt: "Draft the scope." },
      { path: "formula", required: true, formula: "subtotal * tax" },
      { path: "condition", required: true, condition: "amount > 0" },
      {
        path: "conditionAst",
        required: true,
        conditionAst: { type: "literal" },
      },
      {
        path: "source",
        required: true,
        source: { kind: "matter", field: "reference" },
      },
    ];

    for (const field of derivedRequiredFields) {
      expect(isMissingRequiredFieldValue({ field, values: {} })).toBe(false);
    }
  });

  test("property: matches required && user-entered && !aiFillable && (absent || empty)", () => {
    fc.assert(
      fc.property(
        fieldPath,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        // undefined = the key is omitted from `values` entirely.
        fc.option(fc.string(), { nil: undefined }),
        (path, required, isDerived, isAiFillable, value) => {
          const field = {
            path,
            required,
            source: isDerived
              ? { kind: "matter", field: "reference" }
              : undefined,
            aiPrompt: isAiFillable ? "Draft it." : undefined,
          };
          const values = value === undefined ? {} : { [path]: value };

          const expected =
            required &&
            !isDerived &&
            !isAiFillable &&
            (value === undefined || value.trim() === "");

          expect(isMissingRequiredFieldValue({ field, values })).toBe(expected);
        },
      ),
      propertyConfig(),
    );
  });

  test("flags whitespace-only required text as missing, not just the exact empty string", () => {
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: { governing_law: "   " },
      }),
    ).toBe(true);
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: { governing_law: "\t\n " },
      }),
    ).toBe(true);
    // Real (non-whitespace-only) content survives trimming untouched.
    expect(
      isMissingRequiredFieldValue({
        field: { path: "governing_law", required: true },
        values: { governing_law: "  Czech  " },
      }),
    ).toBe(false);
  });

  test("checks a required loop item field per array row, not the flat dotted path", () => {
    const field = { path: "persons.member", required: true };

    // resolvePath("persons.member", values) cannot index into the array and
    // would report this as always missing; the per-row traversal must not.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: [{ member: "Alice" }, { member: "Bob" }] },
      }),
    ).toBe(false);

    // One row leaves it empty.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: [{ member: "Alice" }, { member: "" }] },
      }),
    ).toBe(true);

    // One row omits it entirely.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: [{ member: "Alice" }, {}] },
      }),
    ).toBe(true);

    // Whitespace-only counts as missing inside a row too.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: [{ member: "  " }] },
      }),
    ).toBe(true);

    // No rows: nothing to omit.
    expect(
      isMissingRequiredFieldValue({ field, values: { persons: [] } }),
    ).toBe(false);

    // The array itself absent: not a repeatable path in these values, so it
    // falls back to the plain top-level check, which is also absent.
    expect(isMissingRequiredFieldValue({ field, values: {} })).toBe(true);
  });

  test("flags a non-object row as missing a required loop item field", () => {
    const field = { path: "persons.member", required: true };

    // A non-object row can never supply an object field's value, so it must
    // not silently pass validation the way mapRepeatablePath's transform
    // callers (date/composite/formula/lookup steps) skip such a row for.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: ["invalid"] },
      }),
    ).toBe(true);

    // One good row plus one bad row still fails the check.
    expect(
      isMissingRequiredFieldValue({
        field,
        values: { persons: [{ member: "Alice" }, "invalid"] },
      }),
    ).toBe(true);
  });

  test("does not check a required loop item field for a derived or AI-fillable row value", () => {
    expect(
      isMissingRequiredFieldValue({
        field: {
          path: "persons.member",
          required: true,
          aiPrompt: "Draft the member's role.",
        },
        values: { persons: [{ member: "" }] },
      }),
    ).toBe(false);
  });
});

describe("collectMissingRequiredFields", () => {
  const requiredField = {
    path: "governing_law",
    label: "Governing law",
    inputType: "select",
    options: ["Czech", "Slovak"],
    required: true,
  };

  test("enforce: reports each missing required field with its display metadata", () => {
    expect(
      collectMissingRequiredFields({
        fields: [requiredField],
        policy: "enforce",
        values: {},
      }),
    ).toEqual([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "select",
        options: ["Czech", "Slovak"],
      },
    ]);
  });

  test("enforce: reports nothing once every required field is present", () => {
    expect(
      collectMissingRequiredFields({
        fields: [requiredField],
        policy: "enforce",
        values: { governing_law: "Czech" },
      }),
    ).toEqual([]);
  });

  test("allow-partial: never reports a missing field, even when one is truly absent", () => {
    expect(
      collectMissingRequiredFields({
        fields: [requiredField],
        policy: "allow-partial",
        values: {},
      }),
    ).toEqual([]);
  });

  test("defaults absent label/inputType/options to the same shape describeStoredTemplate uses", () => {
    expect(
      collectMissingRequiredFields({
        fields: [{ path: "note", required: true }],
        policy: "enforce",
        values: {},
      }),
    ).toEqual([
      { path: "note", label: null, inputType: "text", options: null },
    ]);
  });
});
