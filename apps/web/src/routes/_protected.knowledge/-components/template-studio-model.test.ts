import { describe, expect, test } from "bun:test";

import { buildManifest, parseFields } from "./template-studio-model";
import {
  templateValueSourcePatch,
  templateValueSourceTransition,
  type TemplateEditableField,
} from "./template-value-source";

describe("template value-source state", () => {
  test("drops rival persisted sources and round-trips the selected source", () => {
    const [field] = parseFields({
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
            registry: "companies-house",
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

  test("preserves AI adaptation for a registry lookup", () => {
    const [field] = parseFields({
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

    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([
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
    ]);
  });

  test("preserves AI adaptation for a composite field", () => {
    const [field] = parseFields({
      fields: [
        {
          path: "company",
          inputType: "text",
          aiPrompt: "Match the surrounding grammatical case.",
          aiAdapt: true,
          parts: [{ key: "name", inputType: "text" }],
          format: "{{name}}",
        },
      ],
    });

    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([
      {
        path: "company",
        inputType: "text",
        aiPrompt: "Match the surrounding grammatical case.",
        aiAdapt: true,
        parts: [
          {
            key: "name",
            inputType: "text",
            options: [],
            label: undefined,
            pattern: undefined,
          },
        ],
        format: "{{name}}",
      },
    ]);
  });

  test("preserves AI drafting for a composite field", () => {
    const [field] = parseFields({
      fields: [
        {
          path: "company",
          inputType: "text",
          aiPrompt: "Draft the company name.",
          aiSeesDocument: true,
          parts: [{ key: "name", inputType: "text" }],
          format: "{{name}}",
        },
      ],
    });

    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([
      {
        path: "company",
        inputType: "text",
        aiPrompt: "Draft the company name.",
        aiSeesDocument: true,
        parts: [
          {
            key: "name",
            inputType: "text",
            options: [],
            label: undefined,
            pattern: undefined,
          },
        ],
        format: "{{name}}",
      },
    ]);
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

  test("drops AI settings that are incompatible with the selected source", () => {
    const [field] = parseFields({
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

    expect(
      buildManifest({}, field === undefined ? [] : [field]).fields,
    ).toEqual([{ path: "amount", inputType: "number", formula: "base * 2" }]);
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

  test("keeps derived composite formats synchronized with part edits", () => {
    const field = {
      path: "name",
      kind: "string",
      label: "Name",
      inputType: "text",
      required: false,
      options: [],
      parts: [{ key: "first", inputType: "text", options: [] }],
      valueSource: { type: "input" },
    } satisfies TemplateEditableField;
    const initialSource = templateValueSourcePatch(field, {
      preserveDraft: true,
    });
    const nextParts = [
      ...field.parts,
      { key: "last", inputType: "text" as const, options: [] },
    ];
    const nextSource = templateValueSourceTransition({
      field: { ...field, ...initialSource },
      patch: { parts: nextParts },
      preserveDraft: true,
    });

    expect(initialSource).toMatchObject({
      valueSource: { type: "composite", format: "{{first}}" },
      format: undefined,
    });
    expect(nextSource).toMatchObject({
      valueSource: {
        type: "composite",
        format: "{{first}} {{last}}",
      },
      format: undefined,
    });
  });

  test("constructs an explicit formula transition from a composite", () => {
    const field = {
      path: "amount",
      kind: "number",
      label: "Amount",
      inputType: "number",
      required: false,
      options: [],
      parts: [{ key: "value", inputType: "text", options: [] }],
      format: "{{value}}",
      valueSource: {
        type: "composite",
        parts: [{ key: "value", inputType: "text", options: [] }],
        format: "{{value}}",
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
      parts: undefined,
      format: undefined,
      lookup: undefined,
      formula: "",
      source: undefined,
      condition: undefined,
      conditionAst: undefined,
    });
  });
});
