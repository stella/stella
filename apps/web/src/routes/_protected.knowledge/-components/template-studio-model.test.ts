import { describe, expect, test } from "bun:test";

import { buildManifest, parseFields } from "./template-studio-model";
import {
  templateValueSourcePatch,
  type TemplateEditableField,
} from "./template-wizard";

describe("template value-source state", () => {
  test("drops rival persisted sources and round-trips the selected source", () => {
    const [field] = parseFields({
      version: 1,
      fields: [
        {
          path: "company",
          inputType: "text",
          lookup: {
            registry: "companies_house",
            formats: [{ key: "output_1", template: "{{name}}" }],
          },
          formula: "1 + 1",
          parts: [{ key: "first", inputType: "text" }],
          format: "{{first}}",
        },
      ],
    });

    expect(field?.valueSource).toMatchObject({
      type: "composite",
      format: "{{first}}",
    });
    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([
      {
        path: "company",
        inputType: "text",
        parts: [
          {
            key: "first",
            inputType: "text",
            options: [],
            label: undefined,
            pattern: undefined,
          },
        ],
        format: "{{first}}",
      },
    ]);
  });

  test("keeps a formula exclusive when a legacy lookup sibling is present", () => {
    const [field] = parseFields({
      fields: [
        {
          path: "amount",
          inputType: "number",
          formula: "base * 2",
          lookup: {
            registry: "companies_house",
            formats: [{ key: "output_1", template: "{{name}}" }],
          },
        },
      ],
    });

    expect(field?.valueSource).toEqual({
      type: "formula",
      formula: "base * 2",
    });
    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([{ path: "amount", inputType: "number", formula: "base * 2" }]);
  });

  test("does not serialize a stale legacy sibling against the discriminator", () => {
    const [field] = parseFields({
      fields: [{ path: "amount", inputType: "number" }],
    });
    if (field === undefined) {
      throw new Error("expected parsed field");
    }

    const stale = { ...field, formula: "base * 2" };
    expect(buildManifest({}, [stale]).fields).toEqual([
      { path: "amount", inputType: "number" },
    ]);
  });

  test("preserves an incomplete composite while editing, then normalizes it on save", () => {
    const field = {
      path: "name",
      kind: "string",
      label: "Name",
      inputType: "text",
      required: false,
      options: [],
      parts: [{ key: "", inputType: "text", options: [] }],
      format: "",
      valueSource: { type: "input" },
    } satisfies TemplateEditableField;
    const draft = {
      ...field,
      ...templateValueSourcePatch(field, { preserveDraft: true }),
    };

    expect(draft.valueSource).toEqual({
      type: "composite-draft",
      parts: [{ key: "", inputType: "text", options: [] }],
      format: "",
    });
    expect(
      buildManifest({}, [
        {
          ...draft,
          aiPrompt: undefined,
          aiAdapt: false,
          aiSeesDocument: false,
        },
      ]).fields,
    ).toEqual([{ path: "name", label: "Name", inputType: "text" }]);
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
      buildManifest({}, [
        {
          ...draft,
          aiPrompt: undefined,
          aiAdapt: false,
          aiSeesDocument: false,
        },
      ]).fields,
    ).toEqual([{ path: "amount", label: "Amount", inputType: "number" }]);
  });
});
