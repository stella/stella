import { describe, expect, test } from "bun:test";

import {
  checkDependentFields,
  collectSourceValues,
  validateDependentFields,
} from "./dependent-fields";
import type { FieldMeta } from "./types";

const leadPartyField: FieldMeta = {
  path: "lead_party",
  inputType: "select",
  optionsFrom: "parties.name",
};

describe("collectSourceValues", () => {
  test("maps an array-item path over every item", () => {
    expect(
      collectSourceValues("parties.name", {
        parties: [{ name: "Acme" }, { name: "Globex" }],
      }),
    ).toEqual(["Acme", "Globex"]);
  });

  test("prefers the exact flat dotted key, including string arrays", () => {
    expect(
      collectSourceValues("parties.name", {
        "parties.name": ["Acme", "Globex"],
        parties: [{ name: "shadowed" }],
      }),
    ).toEqual(["Acme", "Globex"]);
  });

  test("collects a scalar source as a one-element list", () => {
    expect(collectSourceValues("company", { company: "Acme" })).toEqual([
      "Acme",
    ]);
  });

  test("stringifies numbers and drops blanks, duplicates, and non-leaves", () => {
    expect(
      collectSourceValues("items.qty", {
        items: [{ qty: 12 }, { qty: "  " }, { qty: 12 }, { other: "x" }],
      }),
    ).toEqual(["12"]);
  });

  test("returns empty for a missing source", () => {
    expect(collectSourceValues("parties.name", {})).toEqual([]);
  });
});

describe("validateDependentFields", () => {
  test("accepts a value present in the source field's items", () => {
    expect(
      validateDependentFields({
        values: {
          parties: [{ name: "Acme" }, { name: "Globex" }],
          lead_party: "Globex",
        },
        fields: [leadPartyField],
      }),
    ).toEqual([]);
  });

  test("rejects a value outside the source, naming field and source", () => {
    const errors = validateDependentFields({
      values: {
        parties: [{ name: "Acme" }],
        lead_party: "Initech",
      },
      fields: [leadPartyField],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("lead_party");
    expect(errors[0]?.optionsFrom).toBe("parties.name");
    expect(errors[0]?.message).toContain('"lead_party"');
    expect(errors[0]?.message).toContain('"Initech"');
    expect(errors[0]?.message).toContain('"parties.name"');
  });

  test("falls back to static options while the source is empty", () => {
    const field: FieldMeta = { ...leadPartyField, options: ["Acme"] };

    expect(
      validateDependentFields({
        values: { lead_party: "Acme" },
        fields: [field],
      }),
    ).toEqual([]);
    expect(
      validateDependentFields({
        values: { lead_party: "Globex" },
        fields: [field],
      }),
    ).toHaveLength(1);
  });

  test("accepts anything when neither source values nor options exist", () => {
    expect(
      validateDependentFields({
        values: { lead_party: "whatever" },
        fields: [leadPartyField],
      }),
    ).toEqual([]);
  });

  test("skips absent, empty, and non-string dependent values", () => {
    expect(
      validateDependentFields({
        values: {
          parties: [{ name: "Acme" }],
          lead_party: true,
          empty_dep: "  ",
        },
        fields: [
          leadPartyField,
          { path: "empty_dep", optionsFrom: "parties.name" },
          { path: "missing", optionsFrom: "parties.name" },
        ],
      }),
    ).toEqual([]);
  });

  test("resolves a nested dependent field path", () => {
    const field: FieldMeta = {
      path: "contract.lead",
      optionsFrom: "parties.name",
    };

    const errors = validateDependentFields({
      values: {
        parties: [{ name: "Acme" }],
        contract: { lead: "Globex" },
      },
      fields: [field],
    });
    expect(errors).toHaveLength(1);
  });
});

describe("checkDependentFields", () => {
  test("returns null without a manifest or without errors", () => {
    expect(checkDependentFields({ lead_party: "x" }, null)).toBeNull();
    expect(
      checkDependentFields(
        { parties: [{ name: "x" }], lead_party: "x" },
        { fields: [leadPartyField] },
      ),
    ).toBeNull();
  });

  test("joins error messages for the boundary response", () => {
    const message = checkDependentFields(
      { parties: [{ name: "Acme" }], lead_party: "Globex" },
      { fields: [leadPartyField] },
    );
    expect(message).toContain('"lead_party"');
    expect(message).toContain('"parties.name"');
  });
});
