import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  collectTemplateInputKeys,
  findUnusedTemplateValueKeys,
} from "./template-input-contract";

// Discovery emits structural object roots as fields alongside terminal
// placeholders, so production declares both `company` and `company.name`.
const DECLARED_KEYS = ["name", "company", "company.name"] as const;

describe("template input contract", () => {
  test("combines discovery, placeholders, and manifest-only fields", () => {
    expect(
      collectTemplateInputKeys({
        discoveredFieldPaths: ["client.name"],
        manifestFieldPaths: ["rent", "rent_annual"],
        placeholderPaths: ["signature_date"],
      }),
    ).toEqual(
      new Set(["client.name", "rent", "rent_annual", "signature_date"]),
    );
  });

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

  test("rejects unknown leaves inside repeated namespace rows", () => {
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys: ["sellers", "sellers.name"],
        values: { sellers: [{ name: "Ada" }, { namme: "Grace" }] },
      }),
    ).toEqual(["sellers.namme"]);
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

  test("INVARIANT: terminal fields accept every JSON value shape", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(
          findUnusedTemplateValueKeys({
            declaredKeys: DECLARED_KEYS,
            values: { name: value },
          }),
        ).toEqual([]);
      }),
      propertyConfig(),
    );
  });
});
