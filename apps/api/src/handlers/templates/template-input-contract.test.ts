import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { findUnusedTemplateValueKeys } from "./template-input-contract";

const DECLARED_KEYS = ["name", "company.name"] as const;

describe("template input contract", () => {
  test("accepts top-level and flattened declared paths", () => {
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys: DECLARED_KEYS,
        values: { name: "Ada", company: { name: "Stella" } },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys: DECLARED_KEYS,
        values: { "company.name": "Stella" },
      }),
    ).toEqual([]);
  });

  test("rejects extra keys independently of every supported value type", () => {
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys: DECLARED_KEYS,
        values: {
          name: "Ada",
          typoString: "value",
          typoNumber: 1,
          typoBoolean: true,
          typoArray: ["value"],
          typoObject: { nested: "value" },
        },
      }),
    ).toEqual([
      "typoString",
      "typoNumber",
      "typoBoolean",
      "typoArray",
      "typoObject",
    ]);
  });

  test("rejects unknown leaves inside declared namespaces", () => {
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys: DECLARED_KEYS,
        values: { company: { name: "Stella", namme: "typo" } },
      }),
    ).toEqual(["company.namme"]);
  });

  test("INVARIANT: value shape cannot change whether an unknown key is rejected", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(
          findUnusedTemplateValueKeys({
            declaredKeys: DECLARED_KEYS,
            values: { unknown: value },
          }),
        ).toEqual(["unknown"]);
      }),
      propertyConfig(),
    );
  });
});
