import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  collectTemplateInputKeys,
  findUnusedTemplateValueKeys,
  isFillableTemplateInputField,
} from "./template-input-contract";

// Discovery emits structural object roots as fields alongside terminal
// placeholders, so production declares both `company` and `company.name`.
const DECLARED_KEYS = ["name", "company", "company.name"] as const;

describe("template input contract", () => {
  test("uses one fillable-field predicate for listing and strict input", () => {
    expect(isFillableTemplateInputField({})).toBe(true);
    expect(isFillableTemplateInputField({ formula: "rent * 12" })).toBe(false);
    expect(isFillableTemplateInputField({ condition: "client.type" })).toBe(
      false,
    );
    expect(isFillableTemplateInputField({ conditionAst: {} })).toBe(false);
  });

  test("raw templates accept every live discovered path", () => {
    expect(
      collectTemplateInputKeys({
        type: "raw",
        livePaths: ["client.name", "signature_date"],
      }),
    ).toEqual(new Set(["client.name", "signature_date"]));
  });

  test("manifest templates accept live descendants but exclude derived outputs", () => {
    expect(
      collectTemplateInputKeys({
        type: "manifest",
        derivedOutputPaths: ["company.full", "rent_annual"],
        fillableFieldPaths: ["company", "rent"],
        livePaths: [
          "company",
          "company.full",
          "company.seat",
          "rent",
          "rent_annual",
          "unlisted",
        ],
      }),
    ).toEqual(new Set(["company", "company.seat", "rent"]));
  });

  test("manifest derived subtrees cannot leak through deeper live markers", () => {
    expect(
      collectTemplateInputKeys({
        type: "manifest",
        derivedOutputPaths: ["company.full"],
        fillableFieldPaths: ["company"],
        livePaths: ["company.full.address"],
      }),
    ).toEqual(new Set(["company"]));
  });

  test("manifest paths cannot be accepted outside a fillable root", () => {
    expect(
      collectTemplateInputKeys({
        type: "manifest",
        derivedOutputPaths: [],
        fillableFieldPaths: ["company"],
        livePaths: ["unlisted.value"],
      }),
    ).toEqual(new Set(["company"]));
  });

  test("manifest-only fillable fields remain accepted", () => {
    expect(
      collectTemplateInputKeys({
        type: "manifest",
        derivedOutputPaths: [],
        fillableFieldPaths: ["client.type", "rent"],
        livePaths: [],
      }),
    ).toEqual(new Set(["client.type", "rent"]));
  });

  test("raw and manifest input policies are discriminated", () => {
    expect(
      collectTemplateInputKeys({
        type: "raw",
        livePaths: ["company.full"],
      }),
    ).toEqual(new Set(["company.full"]));
    expect(
      collectTemplateInputKeys({
        type: "manifest",
        derivedOutputPaths: ["company.full"],
        fillableFieldPaths: ["company"],
        livePaths: ["company.full"],
      }),
    ).toEqual(new Set(["company"]));
  });

  test("manifest nested live paths support flattened input", () => {
    const declaredKeys = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: [],
      fillableFieldPaths: ["company"],
      livePaths: ["company.seat"],
    });
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys,
        values: { "company.seat": "Prague" },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        declaredKeys,
        values: { company: { namme: "typo" } },
      }),
    ).toEqual(["company.namme"]);
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
