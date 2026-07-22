import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  collectRawTemplateInputSources,
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
  arrayPaths: new Set(),
  forbiddenPaths: new Set(),
  primitiveArrayPaths: new Set(),
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
      arrayPaths: [],
      primitiveArrayPaths: [],
      terminalPaths: ["client.name", "signature_date"],
    });
    expect(contract.acceptedPaths).toEqual(
      new Set(["client.name", "signature_date"]),
    );
    expect(contract.forbiddenPaths).toEqual(new Set());
    expect(contract.primitiveArrayPaths).toEqual(new Set());
  });

  test("raw static loops accept an array root with no item fields", () => {
    const sources = collectRawTemplateInputSources({
      fields: [{ path: "rows", kind: "array", itemFields: [] }],
      placeholderPaths: [],
    });
    const contract = collectTemplateInputKeys({ type: "raw", ...sources });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { rows: [{}, {}] },
      }),
    ).toEqual([]);
  });

  test("raw loops with item fields keep their array root recursion-only", () => {
    const sources = collectRawTemplateInputSources({
      fields: [
        {
          path: "rows",
          kind: "array",
          itemFields: [{ path: "name", kind: "string" }],
        },
      ],
      placeholderPaths: [],
    });
    expect(sources).toEqual({
      arrayPaths: ["rows"],
      primitiveArrayPaths: [],
      terminalPaths: ["rows.name"],
    });
    const contract = collectTemplateInputKeys({ type: "raw", ...sources });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { rows: [{ name: "Ada" }] },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { "rows.name": "Ada" },
      }),
    ).toEqual(["rows.name"]);
    fc.assert(
      fc.property(
        fc.jsonValue().filter((value) => !Array.isArray(value)),
        (rows) => {
          expect(
            findUnusedTemplateValueKeys({ contract, values: { rows } }),
          ).toEqual(["rows"]);
        },
      ),
      propertyConfig(),
    );
  });

  test("raw value loops explicitly accept supported primitive rows", () => {
    const sources = collectRawTemplateInputSources({
      fields: [
        {
          path: "tags",
          kind: "array",
          itemFields: [{ path: "value", kind: "string" }],
        },
      ],
      placeholderPaths: ["tags.value"],
    });
    expect(sources).toEqual({
      arrayPaths: ["tags"],
      primitiveArrayPaths: ["tags"],
      terminalPaths: ["tags.value", "tags.value"],
    });
    const contract = collectTemplateInputKeys({ type: "raw", ...sources });

    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        (tags) => {
          expect(
            findUnusedTemplateValueKeys({ contract, values: { tags } }),
          ).toEqual([]);
        },
      ),
      propertyConfig(),
    );
    expect(
      findUnusedTemplateValueKeys({ contract, values: { tags: [null] } }),
    ).toEqual(["tags"]);
  });

  test("raw dotted value loops preserve their nested primitive contract", () => {
    const sources = collectRawTemplateInputSources({
      fields: [
        {
          path: "deal.tags",
          kind: "array",
          itemFields: [{ path: "value", kind: "string" }],
        },
      ],
      placeholderPaths: ["deal.tags.value"],
    });
    expect(sources.primitiveArrayPaths).toEqual(["deal.tags"]);
    expect(sources.arrayPaths).toEqual(["deal.tags"]);

    const contract = collectTemplateInputKeys({ type: "raw", ...sources });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { deal: { tags: ["urgent"] } },
      }),
    ).toEqual([]);
  });

  test("raw dotted condition fields accept nested values and reject siblings", () => {
    const sources = collectRawTemplateInputSources({
      fields: [{ path: "client.has_spouse", kind: "boolean" }],
      placeholderPaths: [],
    });
    const contract = collectTemplateInputKeys({ type: "raw", ...sources });

    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { client: { has_spouse: true } },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { client: { has_spouse: true, typo: true } },
      }),
    ).toEqual(["client.typo"]);
  });

  test("nested loop contracts accept inherited outer-row condition fields", () => {
    const sources = collectRawTemplateInputSources({
      fields: [
        {
          path: "groups",
          kind: "array",
          itemFields: [{ path: "group_enabled", kind: "boolean" }],
        },
        {
          path: "groups.items",
          kind: "array",
          itemFields: [{ path: "group_enabled", kind: "boolean" }],
        },
      ],
      placeholderPaths: [],
    });
    const contract = collectTemplateInputKeys({ type: "raw", ...sources });

    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: {
          groups: [{ group_enabled: true, items: [{}, {}] }],
        },
      }),
    ).toEqual([]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: {
          groups: [{ group_enabled: true, typo: true, items: [{}] }],
        },
      }),
    ).toEqual(["groups.typo"]);
  });

  test("manifest templates accept live descendants but exclude derived outputs", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: ["company.full", "rent_annual"],
      fillableFieldPaths: ["company", "rent"],
      primitiveArrayPaths: [],
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
      arrayPaths: [],
      derivedOutputPaths: ["company.full"],
      fillableFieldPaths: ["company"],
      primitiveArrayPaths: [],
      livePaths: ["company.full.address"],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["company"]));
    expect(contract.forbiddenPaths).toEqual(new Set(["company.full"]));
  });

  test("manifest paths cannot be accepted outside a fillable root", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: [],
      fillableFieldPaths: ["company"],
      primitiveArrayPaths: [],
      livePaths: ["unlisted.value"],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["company"]));
  });

  test("manifest-only fillable fields remain accepted", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: [],
      fillableFieldPaths: ["client.type", "rent"],
      primitiveArrayPaths: [],
      livePaths: [],
    });
    expect(contract.acceptedPaths).toEqual(new Set(["client.type", "rent"]));
  });

  test("raw and manifest input policies are discriminated", () => {
    const raw = collectTemplateInputKeys({
      type: "raw",
      arrayPaths: [],
      primitiveArrayPaths: [],
      terminalPaths: ["company.full"],
    });
    expect(raw.acceptedPaths).toEqual(new Set(["company.full"]));
    const manifest = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: ["company.full"],
      fillableFieldPaths: ["company"],
      primitiveArrayPaths: [],
      livePaths: ["company.full"],
    });
    expect(manifest.acceptedPaths).toEqual(new Set(["company"]));
    expect(manifest.forbiddenPaths).toEqual(new Set(["company.full"]));
  });

  test("manifest nested live paths support flattened input", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: [],
      fillableFieldPaths: ["company"],
      primitiveArrayPaths: [],
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

  test("raw structural namespaces reject leaf values", () => {
    const contract = collectTemplateInputKeys({
      type: "raw",
      arrayPaths: [],
      primitiveArrayPaths: [],
      terminalPaths: ["company.name"],
    });
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { company: "Acme" },
      }),
    ).toEqual(["company"]);
    expect(
      findUnusedTemplateValueKeys({
        contract,
        values: { company: { name: "Acme" } },
      }),
    ).toEqual([]);
    fc.assert(
      fc.property(fc.array(fc.jsonValue()), (company) => {
        expect(
          findUnusedTemplateValueKeys({ contract, values: { company } }),
        ).toEqual(["company"]);
      }),
      propertyConfig(),
    );
  });

  test("forbidden derived paths win through nested and flattened input", () => {
    const contract = collectTemplateInputKeys({
      type: "manifest",
      arrayPaths: [],
      derivedOutputPaths: ["company.seat"],
      fillableFieldPaths: ["company"],
      primitiveArrayPaths: [],
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
        contract: {
          ...contractFor(["sellers", "sellers.name"]),
          arrayPaths: new Set(["sellers"]),
        },
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
          arrayPaths: new Set(["items"]),
          forbiddenPaths: new Set(["items.total"]),
          primitiveArrayPaths: new Set(),
        },
        values: { items: ["invalid"] },
      }),
    ).toEqual(["items"]);
  });

  test("INVARIANT: loop descendants require their array container", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("name", "address.city", "value"),
        fc.jsonValue(),
        (field, value) => {
          const path = `items.${field}`;
          expect(
            findUnusedTemplateValueKeys({
              contract: {
                acceptedPaths: new Set([path]),
                arrayPaths: new Set(["items"]),
                forbiddenPaths: new Set(),
                primitiveArrayPaths: new Set(),
              },
              values: { [path]: value },
            }),
          ).toEqual([path]);
        },
      ),
      propertyConfig(),
    );
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
