import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import * as v from "valibot";

import { fieldMetaToolInputSchema } from "@/api/lib/docx/types";
import type {
  FieldSource,
  fieldSourceToolInputSchema,
} from "@/api/lib/template-binding/binding-sources";
import {
  readTemplateFieldsInput,
  templateFieldInputSchema,
  toFieldMetaToolInput,
  toTemplateFieldWireInput,
} from "@/api/mcp/template-field-input";

const sortedKeys = (entries: object): string[] => Object.keys(entries).sort();

const camelize = (key: string): string =>
  key.replace(/_(.)/gu, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );

const sortedCamelKeys = (entries: object): string[] =>
  Object.keys(entries).map(camelize).sort();

const advertised = templateFieldInputSchema.pipe[0].entries;
const persisted = fieldMetaToolInputSchema.pipe[0].entries;

describe("template field input schema", () => {
  test("preserves the persisted source union in the portable schema", () => {
    expectTypeOf<
      v.InferOutput<typeof fieldSourceToolInputSchema>
    >().toEqualTypeOf<FieldSource>();
  });

  test("advertises the persisted tool-input keys in snake_case", () => {
    expect(sortedCamelKeys(advertised)).toEqual(sortedKeys(persisted));
  });

  test("advertises the persisted validation keys in snake_case", () => {
    expect(
      sortedCamelKeys(advertised.validation.wrapped.pipe[0].entries),
    ).toEqual(sortedKeys(persisted.validation.wrapped.pipe[0].entries));
  });

  test("advertises the persisted part keys in snake_case", () => {
    expect(
      sortedCamelKeys(advertised.parts.wrapped.pipe[0].item.entries),
    ).toEqual(sortedKeys(persisted.parts.wrapped.pipe[0].item.entries));
  });

  test("maps every advertised key onto its persisted spelling", () => {
    const mapped = toFieldMetaToolInput({
      path: "company",
      label: "Company",
      hint: "Enter the registry number",
      input_type: "select",
      options: ["director", "proxy"],
      validation: {
        required: true,
        min_length: 1,
        max_length: 64,
        min: 0,
        max: 12,
        pattern: "^.+$",
        min_items: 1,
        max_items: 3,
      },
      required: true,
      ai_prompt: "Draft the scope",
      ai_adapt: true,
      ai_sees_document: true,
      parts: [
        {
          key: "title",
          label: "Title",
          input_type: "select",
          options: ["Mr", "Ms"],
          pattern: "^.+$",
        },
      ],
      format: "{{title}} {{name}}",
      options_from: "parties",
      lookup: {
        registry: "krs",
        formats: [{ key: "default", template: "[name]" }],
      },
      source: {
        kind: "contact",
        field: "displayName",
      },
      formula: "rent * 12",
      condition: "type == 'corp'",
      date_format: { locale: "cs", style: "long" },
    });

    expect(sortedKeys(mapped)).toEqual(sortedKeys(persisted));
    expect(sortedKeys(mapped.validation ?? {})).toEqual(
      sortedKeys(persisted.validation.wrapped.pipe[0].entries),
    );
    expect(sortedKeys(mapped.parts?.at(0) ?? {})).toEqual(
      sortedKeys(persisted.parts.wrapped.pipe[0].item.entries),
    );
  });

  test("omits absent optional keys instead of writing undefined", () => {
    expect(toFieldMetaToolInput({ path: "company" })).toEqual({
      path: "company",
    });
  });

  test("round-trips a parsed field into the persisted tool input", () => {
    const parsed = v.parse(templateFieldInputSchema, {
      path: "company",
      label: "Company",
      input_type: "select",
      options_from: "parties",
      ai_sees_document: false,
      validation: { required: true, min_length: 2, max_items: 4 },
      parts: [{ key: "title", input_type: "text" }],
      format: "{{title}}",
      date_format: { locale: "cs", style: "long" },
    });

    const mapped = toFieldMetaToolInput(parsed);

    expect(v.parse(fieldMetaToolInputSchema, mapped)).toEqual({
      path: "company",
      label: "Company",
      inputType: "select",
      optionsFrom: "parties",
      aiSeesDocument: false,
      validation: { required: true, minLength: 2, maxItems: 4 },
      parts: [{ key: "title", inputType: "text" }],
      format: "{{title}}",
      dateFormat: { locale: "cs", style: "long" },
    });
  });

  test("serializes every persisted field key back onto the accepted wire contract", () => {
    const persistedField = v.parse(fieldMetaToolInputSchema, {
      path: "company",
      label: "Company",
      hint: "Enter the registry number",
      inputType: "select",
      options: ["director"],
      validation: {
        required: true,
        minLength: 1,
        maxLength: 64,
        min: 0,
        max: 12,
        pattern: "^.+$",
        minItems: 1,
        maxItems: 3,
      },
      required: true,
      aiSeesDocument: true,
      parts: [
        {
          key: "title",
          label: "Title",
          inputType: "select",
          options: ["Mr"],
          pattern: "^.+$",
        },
      ],
      format: "{{title}}",
      optionsFrom: "parties",
      dateFormat: { locale: "cs", style: "long" },
    });

    const wireField = toTemplateFieldWireInput(persistedField);
    const censusField = toTemplateFieldWireInput({
      ...persistedField,
      aiPrompt: "Draft the scope",
      aiAdapt: true,
      lookup: {
        registry: "krs",
        formats: [{ key: "default", template: "[name]" }],
      },
      source: {
        kind: "contact",
        field: "displayName",
      },
      formula: "rent * 12",
      condition: "type == 'corp'",
    });

    expect(sortedKeys(censusField)).toEqual(sortedKeys(advertised));
    expect(sortedKeys(wireField.validation ?? {})).toEqual(
      sortedKeys(advertised.validation.wrapped.pipe[0].entries),
    );
    expect(sortedKeys(wireField.parts?.at(0) ?? {})).toEqual(
      sortedKeys(advertised.parts.wrapped.pipe[0].item.entries),
    );
    expect(
      toFieldMetaToolInput(v.parse(templateFieldInputSchema, wireField)),
    ).toEqual(persistedField);
  });

  test("accepts the describe producer's default flags beside a derived lookup", () => {
    const wireField = toTemplateFieldWireInput({
      path: "company",
      label: null,
      hint: null,
      inputType: "text",
      options: null,
      validation: null,
      required: false,
      lookup: {
        registry: "krs",
        formats: [{ key: "default", template: "[name]" }],
      },
      source: null,
      aiSeesDocument: false,
      aiPrompt: null,
      aiAdapt: false,
      optionsFrom: null,
      dateFormat: null,
      parts: null,
      format: null,
    });

    const parsed = v.parse(
      v.array(templateFieldInputSchema),
      readTemplateFieldsInput([wireField]),
    );

    expect(parsed).toEqual([
      {
        path: "company",
        input_type: "text",
        required: false,
        lookup: {
          registry: "krs",
          formats: [{ key: "default", template: "[name]" }],
        },
        ai_sees_document: false,
        ai_adapt: false,
      },
    ]);
  });

  test("rejects the persisted camelCase spellings", () => {
    const result = v.safeParse(templateFieldInputSchema, {
      path: "company",
      inputType: "text",
    });

    expect(result.success).toBe(false);
    expect(
      result.issues?.some((issue) => issue.path?.at(0)?.key === "inputType"),
    ).toBe(true);
  });

  test("does not erase null typos borrowed from a different schema level", () => {
    const parsed = v.safeParse(
      v.array(templateFieldInputSchema),
      readTemplateFieldsInput([
        { path: "company", validation: { ai_prompt: null } },
      ]),
    );

    expect(parsed.success).toBe(false);
    expect(
      parsed.issues?.some((issue) => issue.path?.at(-1)?.key === "ai_prompt"),
    ).toBe(true);
  });
});
