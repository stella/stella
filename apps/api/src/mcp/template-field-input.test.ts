import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { fieldMetaToolInputSchema } from "@/api/lib/docx/types";
import { fieldSourceToolInputSchema } from "@/api/lib/template-binding/binding-sources";
import {
  templateFieldInputSchema,
  toFieldMetaToolInput,
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
      // Parsed rather than written inline: the advertised source union is a
      // provider-portable `anyOf`, so a bare literal has no discriminant to
      // narrow against.
      source: v.parse(fieldSourceToolInputSchema, {
        kind: "contact",
        field: "displayName",
      }),
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
});
