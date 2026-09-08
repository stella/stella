import { describe, expect, test } from "bun:test";

import {
  parseFields,
  studioFieldToManifestField,
} from "./template-studio-model";
import {
  templateValueSourcePatch,
  templateValueSourceTransition,
  type TemplateEditableField,
} from "./template-value-source";

/** The persisted shape of one parsed field, or null when nothing parsed. */
const persisted = (fields: ReturnType<typeof parseFields>) => {
  const [field] = fields;
  return field === undefined ? null : studioFieldToManifestField(field);
};

describe("template value-source state", () => {
  test("drops rival persisted sources and round-trips the selected source", () => {
    const fields = parseFields({
      version: 1,
      fields: [
        {
          path: "company",
          inputType: "text",
          lookup: {
            registry: "companies-house",
            formats: [{ key: "output_1", template: "{{name}}" }],
          },
          formula: "1 + 1",
        },
      ],
    });

    expect(fields.at(0)?.valueSource).toEqual({
      type: "formula",
      formula: "1 + 1",
    });
    expect(persisted(fields)).toEqual({
      path: "company",
      inputType: "text",
      formula: "1 + 1",
    });
  });

  test("keeps a formula exclusive when a legacy lookup sibling is present", () => {
    const fields = parseFields({
      fields: [
        {
          path: "amount",
          inputType: "number",
          formula: "base * 2",
          lookup: {
            registry: "companies-house",
            formats: [{ key: "output_1", template: "{{name}}" }],
          },
        },
      ],
    });

    expect(fields.at(0)?.valueSource).toEqual({
      type: "formula",
      formula: "base * 2",
    });
    expect(persisted(fields)).toEqual({
      path: "amount",
      inputType: "number",
      formula: "base * 2",
    });
  });

  test("preserves AI adaptation for a registry lookup", () => {
    const fields = parseFields({
      fields: [
        {
          path: "company",
          inputType: "text",
          aiPrompt: "Match the surrounding grammatical case.",
          aiAdapt: true,
          lookup: {
            registry: "companies-house",
            formats: [{ key: "output_1", template: "{{name}}" }],
          },
        },
      ],
    });

    expect(persisted(fields)).toEqual({
      path: "company",
      inputType: "text",
      aiPrompt: "Match the surrounding grammatical case.",
      aiAdapt: true,
      lookup: {
        registry: "companies-house",
        formats: [{ key: "output_1", template: "{{name}}" }],
      },
    });
  });

  test("preserves AI drafting for a plain input field", () => {
    const fields = parseFields({
      fields: [
        {
          path: "company",
          inputType: "text",
          aiPrompt: "Draft the company name.",
          aiSeesDocument: true,
        },
      ],
    });

    expect(persisted(fields)).toEqual({
      path: "company",
      inputType: "text",
      aiPrompt: "Draft the company name.",
      aiSeesDocument: true,
    });
  });

  test("does not serialize a stale legacy sibling against the discriminator", () => {
    const [field] = parseFields({
      fields: [{ path: "amount", inputType: "number" }],
    });
    if (field === undefined) {
      throw new Error("expected parsed field");
    }

    expect(
      studioFieldToManifestField({ ...field, formula: "base * 2" }),
    ).toEqual({ path: "amount", inputType: "number" });
  });

  test("drops AI settings that are incompatible with the selected source", () => {
    const fields = parseFields({
      fields: [
        {
          path: "amount",
          inputType: "number",
          formula: "base * 2",
          aiPrompt: "Legacy prompt",
          aiAdapt: true,
          aiSeesDocument: true,
        },
      ],
    });

    expect(persisted(fields)).toEqual({
      path: "amount",
      inputType: "number",
      formula: "base * 2",
    });
  });

  test("preserves an empty formula while editing, then omits it on save", () => {
    const field = {
      path: "amount",
      kind: "number",
      label: "Amount",
      inputType: "number",
      required: false,
      options: [],
      formula: "",
      valueSource: { type: "input" },
    } satisfies TemplateEditableField;
    const draft = {
      ...field,
      ...templateValueSourcePatch(field, { preserveDraft: true }),
    };

    expect(draft.valueSource).toEqual({ type: "formula", formula: "" });
    expect(
      studioFieldToManifestField({
        ...draft,
        aiPrompt: undefined,
        aiAdapt: false,
        aiSeesDocument: false,
      }),
    ).toEqual({ path: "amount", label: "Amount", inputType: "number" });
  });

  test("constructs an explicit formula transition from a lookup", () => {
    const field = {
      path: "amount",
      kind: "number",
      label: "Amount",
      inputType: "number",
      required: false,
      options: [],
      lookup: {
        registry: "companies-house",
        formats: [{ key: "output_1", template: "{{name}}" }],
      },
      valueSource: {
        type: "lookup",
        lookup: {
          registry: "companies-house",
          formats: [{ key: "output_1", template: "{{name}}" }],
        },
      },
    } satisfies TemplateEditableField;

    expect(
      templateValueSourceTransition({
        field,
        patch: { formula: "" },
        preserveDraft: true,
      }),
    ).toEqual({
      valueSource: { type: "formula", formula: "" },
      lookup: undefined,
      formula: "",
      source: undefined,
      condition: undefined,
      conditionAst: undefined,
    });
  });
});
