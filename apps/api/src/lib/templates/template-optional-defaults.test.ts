import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  applyOmittedOptionalPlaceholderDefaults,
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
