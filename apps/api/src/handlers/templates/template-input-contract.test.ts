import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  collectTemplateInputKeys,
  findUnusedTemplateValueKeys,
  isFillableTemplateInputField,
  type TemplateInputContract,
} from "./template-input-contract";

// Discovery emits structural object roots as fields alongside terminal
// placeholders, so production declares both `company` and `company.name`.
const DECLARED_KEYS = ["name", "company", "company.name"] as const;
const contractFor = (
  acceptedPaths: Iterable<string>,
): TemplateInputContract => ({
  acceptedPaths: new Set(acceptedPaths),
  forbiddenPaths: new Set(),
});
const DECLARED_CONTRACT = contractFor(DECLARED_KEYS);

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
    const contract = collectTemplateInputKeys({
      type: "raw",
      livePaths: ["client.name", "signature_date"],
    });
    expect(contract.acceptedPaths).toEqual(
      new Set(["client.name", "signature_date"]),
    );
    expect(contract.forbiddenPaths).toEqual(new Set());
  });

  test("manifest templates accept live descendants but exclude derived outputs", () => {
    const contract = collectTemplateInputKeys({
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
    });
    expect(contract.acceptedPaths).toEqual(
      new Set(["company", "company.seat", "rent"]),
    );
    expect(contract.forbiddenPaths).toEqual(
      new Set(["company.full", "rent_annual"]),
    );
  });

  test("manifest derived subtrees cannot leak through deeper live markers", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: ["company.full"],
      fillableFieldPaths: ["company"],
      livePaths: ["company.full.address"],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["company"]));
    expect(contract.forbiddenPaths).toEqual(new Set(["company.full"]));
  });

  test("manifest paths cannot be accepted outside a fillable root", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: [],
      fillableFieldPaths: ["company"],
      livePaths: ["unlisted.value"],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["company"]));
  });

  test("manifest-only fillable fields remain accepted", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: [],
      fillableFieldPaths: ["client.type", "rent"],
      livePaths: [],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["client.type", "rent"]));
  });

  test("raw and manifest input policies are discriminated", () => {
    const raw = collectTemplateInputKeys({
      type: "raw",
      livePaths: ["company.full"],
    });
    expect(raw.acceptedPaths).toEqual(new Set(["company.full"]));
    const manifest = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: ["company.full"],
      fillableFieldPaths: ["company"],
      livePaths: ["company.full"],
    });
    expect(manifest.acceptedPaths).toEqual(new Set(["company"]));
    expect(manifest.forbiddenPaths).toEqual(new Set(["company.full"]));
  });

  test("manifest nested live paths support flattened input", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: [],
      fillableFieldPaths: ["company"],
      livePaths: ["company.seat"],
    });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { "company.seat": "Prague" },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { company: { namme: "typo" } },
      }),
    ).toEqual(["company.namme"]);
  });

  test("forbidden derived paths win through nested and flattened input", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      derivedOutputPaths: ["company.seat"],
      fillableFieldPaths: ["company"],
      livePaths: ["company.seat"],
    });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { company: { seat: "Prague" } },
      }),
    ).toEqual(["company.seat"]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { "company.seat": "Prague" },
      }),
    ).toEqual(["company.seat"]);
  });

  test("accepts top-level and flattened declared paths", () => {
    expect(
      findUnusedTemplateValueKeys({
        contract: DECLARED_CONTRACT,
        values: { name: "Ada", company: { name: "Stella" } },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        contract: DECLARED_CONTRACT,
        values: { "company.name": "Stella" },
      }),
    ).toEqual([]);
  });

  test("rejects extra keys independently of every supported value type", () => {
    expect(
      findUnusedTemplateValueKeys({
        contract: DECLARED_CONTRACT,
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
        contract: DECLARED_CONTRACT,
        values: { company: { name: "Stella", namme: "typo" } },
      }),
    ).toEqual(["company.namme"]);
  });

  test("rejects unknown leaves inside repeated namespace rows", () => {
    expect(
      findUnusedTemplateValueKeys({
        contract: contractFor(["sellers", "sellers.name"]),
        values: { sellers: [{ name: "Ada" }, { namme: "Grace" }] },
      }),
    ).toEqual(["sellers.namme"]);
  });

  test("rejects primitive rows in an accepted-descendant namespace", () => {
    expect(
      findUnusedTemplateValueKeys({
        contract: contractFor(["items.name"]),
        values: { items: ["invalid"] },
      }),
    ).toEqual(["items"]);
  });

  test("rejects primitive rows in a forbidden-descendant namespace", () => {
    expect(
      findUnusedTemplateValueKeys({
        contract: {
          acceptedPaths: new Set(["items"]),
          forbiddenPaths: new Set(["items.total"]),
        },
        values: { items: ["invalid"] },
      }),
    ).toEqual(["items"]);
  });

  test("INVARIANT: value shape cannot change whether an unknown key is rejected", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(
          findUnusedTemplateValueKeys({
            contract: DECLARED_CONTRACT,
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
            contract: DECLARED_CONTRACT,
            values: { name: value },
          }),
        ).toEqual([]);
      }),
      propertyConfig(),
    );
  });
});
