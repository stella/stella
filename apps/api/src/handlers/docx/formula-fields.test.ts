import { describe, expect, test } from "bun:test";

import { applyFormulaFields, resolveFormulaFields } from "./formula-fields";
import { applyManifestFillSteps } from "./manifest-fill-steps";
import type { FieldMeta } from "./types";

const annualRentField: FieldMeta = {
  path: "rent_annual",
  formula: "rent * 12",
};

describe("resolveFormulaFields", () => {
  test("evaluates the formula over submitted values", () => {
    const values: Record<string, unknown> = { rent: "1000" };
    resolveFormulaFields({ values, fields: [annualRentField] });
    expect(values["rent_annual"]).toBe("12000");
  });

  test("indexation cap: indexed rent capped at +5%/yr", () => {
    const values: Record<string, unknown> = { rent: "10000", index: "7" };
    resolveFormulaFields({
      values,
      fields: [
        {
          path: "rent_indexed",
          formula: "min(rent * (1 + index / 100), rent * 1.05)",
        },
      ],
    });
    expect(values["rent_indexed"]).toBe("10500");
  });

  test("ignores a submitted value for a formula field (derived wins)", () => {
    const values: Record<string, unknown> = {
      rent: "1000",
      rent_annual: "99999",
    };
    resolveFormulaFields({ values, fields: [annualRentField] });
    expect(values["rent_annual"]).toBe("12000");
  });

  test("a malformed expression leaves the field unfilled and still drops the submitted value", () => {
    const values: Record<string, unknown> = {
      rent: "1000",
      rent_annual: "99999",
    };
    resolveFormulaFields({
      values,
      fields: [{ path: "rent_annual", formula: "rent **" }],
    });
    expect("rent_annual" in values).toBe(false);
  });

  test("a non-numeric referenced value leaves the field unfilled", () => {
    const values: Record<string, unknown> = { rent: "a lot" };
    resolveFormulaFields({ values, fields: [annualRentField] });
    expect("rent_annual" in values).toBe(false);
  });

  test("evaluates in declaration order, so a formula may reference an earlier one", () => {
    const values: Record<string, unknown> = { rent: "1000" };
    resolveFormulaFields({
      values,
      fields: [
        annualRentField,
        { path: "rent_biennial", formula: "rent_annual * 2" },
      ],
    });
    expect(values["rent_biennial"]).toBe("24000");
  });

  test("resolves dotted-path references and drops a nested submitted value", () => {
    const values: Record<string, unknown> = {
      lease: { rent: "1000" },
      totals: { annual: "99999" },
    };
    resolveFormulaFields({
      values,
      fields: [{ path: "totals.annual", formula: "lease.rent * 12" }],
    });
    // The derived result lands under the flat dotted key (which resolvePath
    // and substitution prefer); the submitted nested leaf is gone.
    expect(values["totals.annual"]).toBe("12000");
    expect(values["totals"]).toEqual({});
  });

  test("skips fields without a formula", () => {
    const values: Record<string, unknown> = { rent: "1000" };
    resolveFormulaFields({ values, fields: [{ path: "rent" }] });
    expect(values).toEqual({ rent: "1000" });
  });
});

describe("applyFormulaFields", () => {
  test("no-ops without a manifest", () => {
    const values: Record<string, unknown> = { rent_annual: "kept" };
    applyFormulaFields(values, null);
    expect(values).toEqual({ rent_annual: "kept" });
  });

  test("evaluates manifest formula fields in place", () => {
    const values: Record<string, unknown> = { rent: "1000" };
    applyFormulaFields(values, { fields: [annualRentField] });
    expect(values["rent_annual"]).toBe("12000");
  });
});

describe("applyManifestFillSteps — formula ordering", () => {
  test("formulas run after composite assembly and before the dependent check", async () => {
    // The composite assembles "10.5" from its parts; the formula doubles it.
    const fields: FieldMeta[] = [
      {
        path: "price",
        parts: [
          { key: "whole", inputType: "text" },
          { key: "frac", inputType: "text" },
        ],
        format: "{{whole}}.{{frac}}",
      },
      { path: "price_doubled", formula: "price * 2" },
    ];
    const values: Record<string, unknown> = {
      price: { whole: "10", frac: "5" },
    };

    const error = await applyManifestFillSteps({
      values,
      manifest: { fields },
      resolveLookup: async () => ({ type: "not-found" }),
    });

    expect(error).toBeNull();
    expect(values["price"]).toBe("10.5");
    expect(values["price_doubled"]).toBe("21");
  });
});
