import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import * as v from "valibot";

import { fieldMetaToolInputSchema } from "@/api/lib/docx/types";
import type {
  FieldSource,
  fieldSourceToolInputSchema,
} from "@/api/lib/template-binding/binding-sources";
import type { TemplateFieldSourceInput } from "@/api/mcp/template-field-input";
import {
  DEFAULT_LOOKUP_FORMAT,
  templateFieldInputSchema,
  toFieldMetaToolInput,
  toTemplateFieldWireInput,
} from "@/api/mcp/template-field-input";
import { configureTemplateFieldsArgsSchema } from "@/api/mcp/template-tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const TEMPLATE_ID = "6f1f4d1e-59b0-4b4f-9a35-4b0ba0f7a1c9";

/** The `fields` entries read the way configure_template_fields reads them:
 * through the tool input schema, which is where null-as-absence lives. */
const parseFieldsOverlay = (fields: unknown) =>
  v.safeParse(configureTemplateFieldsArgsSchema, {
    template_id: TEMPLATE_ID,
    fields,
  });

const sortedKeys = (entries: object): string[] => Object.keys(entries).sort();

const camelize = (key: string): string =>
  key.replace(/_(.)/gu, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );

const sortedCamelKeys = (entries: object): string[] =>
  Object.keys(entries).map(camelize).sort();

const snakeize = (key: string): string =>
  key.replace(/[A-Z]/gu, (letter: string) => `_${letter.toLowerCase()}`);

const advertised = templateFieldInputSchema.pipe[0].entries;
const persisted = fieldMetaToolInputSchema.pipe[0].entries;

type PersistedField = v.InferOutput<typeof fieldMetaToolInputSchema>;

/**
 * The persisted keys the wire's single `source` union folds up. Each is
 * reachable through exactly one branch of that union, so none of them is
 * advertised under its own snake_case key any more.
 */
const PERSISTED_KEYS_FOLDED_INTO_SOURCE = [
  "aiAdapt",
  "aiPrompt",
  "aiSeesDocument",
  "condition",
  "formula",
  "lookup",
] as const satisfies readonly (keyof typeof persisted)[];

const isFoldedIntoSource = (key: string): boolean =>
  PERSISTED_KEYS_FOLDED_INTO_SOURCE.some((folded) => folded === key);

describe("template field input schema", () => {
  test("preserves the persisted source union in the portable schema", () => {
    expectTypeOf<
      v.InferOutput<typeof fieldSourceToolInputSchema>
    >().toEqualTypeOf<FieldSource>();
  });

  test("advertises the persisted tool-input keys in snake_case, bar the ones source folds up", () => {
    expect(sortedCamelKeys(advertised)).toEqual(
      sortedKeys(persisted).filter((key) => !isFoldedIntoSource(key)),
    );
  });

  test("refuses the flat derived keys the source union replaced", () => {
    for (const key of PERSISTED_KEYS_FOLDED_INTO_SOURCE) {
      const parsed = parseFieldsOverlay([
        { path: "company", [snakeize(key)]: "anything" },
      ]);
      expect(parsed.success).toBe(false);
    }
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
      source: { type: "contact", field: "displayName" },
      date_format: { locale: "cs", style: "long" },
    });

    // Every persisted key the surface can write is named: the plain ones with
    // their value, and the derived-source ones the chosen branch does not use
    // cleared, so merging this entry onto a field configured differently
    // leaves no half of the old branch behind.
    expect(sortedKeys(mapped)).toEqual(sortedKeys(persisted));
    for (const key of sortedKeys(persisted).filter(isFoldedIntoSource)) {
      const set = key === "source";
      expect(
        asTestRaw<Record<string, unknown>>(mapped)[key] === undefined,
      ).toBe(!set);
    }
    expect(sortedKeys(mapped.validation ?? {})).toEqual(
      sortedKeys(persisted.validation.wrapped.pipe[0].entries),
    );
    expect(sortedKeys(mapped.parts?.at(0) ?? {})).toEqual(
      sortedKeys(persisted.parts.wrapped.pipe[0].item.entries),
    );
  });

  /**
   * Every key the union folds up still has to reach the manifest under its
   * persisted spelling. One entry per branch, so a branch that stops writing
   * its persisted half fails here rather than silently dropping the field's
   * source. Keyed by branch so a failure names the branch.
   */
  describe("folds each source branch onto its persisted spelling", () => {
    const BRANCH_CASES = {
      person: { source: { type: "person" }, persisted: {} },
      ai_drafted: {
        source: {
          type: "ai",
          prompt: "Draft the recitals",
          sees_document: true,
        },
        persisted: {
          aiPrompt: "Draft the recitals",
          aiSeesDocument: true,
        },
      },
      ai_adapted: {
        source: { type: "ai", adapt: true },
        persisted: { aiAdapt: true },
      },
      lookup: {
        source: {
          type: "lookup",
          registry: "krs",
          formats: [{ key: "default", template: "[name]" }],
        },
        persisted: {
          lookup: {
            registry: "krs",
            formats: [{ key: "default", template: "[name]" }],
          },
        },
      },
      lookup_without_formats: {
        source: { type: "lookup", registry: "ares" },
        persisted: {
          lookup: { registry: "ares", formats: [{ ...DEFAULT_LOOKUP_FORMAT }] },
        },
      },
      contact: {
        source: { type: "contact", field: "displayName" },
        persisted: { source: { kind: "contact", field: "displayName" } },
      },
      party: {
        source: {
          type: "party",
          role: "opposing_party",
          field: "organizationName",
        },
        persisted: {
          source: {
            kind: "party",
            role: "opposing_party",
            field: "organizationName",
          },
        },
      },
      matter: {
        source: { type: "matter", field: "reference" },
        persisted: { source: { kind: "matter", field: "reference" } },
      },
      attorney: {
        source: { type: "attorney", ref: "lead", field: "name" },
        persisted: { source: { kind: "attorney", ref: "lead", field: "name" } },
      },
      firm: {
        source: { type: "firm", field: "name" },
        persisted: { source: { kind: "firm", field: "name" } },
      },
      formula: {
        source: { type: "formula", expression: "rent * 12" },
        persisted: { formula: "rent * 12" },
      },
      condition: {
        source: { type: "condition", expression: "type == 'corp'" },
        persisted: { condition: "type == 'corp'" },
      },
    } satisfies Record<
      string,
      { persisted: Partial<PersistedField>; source: TemplateFieldSourceInput }
    >;

    for (const [name, { persisted: expected, source }] of Object.entries(
      BRANCH_CASES,
    )) {
      test(name, () => {
        expect(
          toFieldMetaToolInput(
            v.parse(templateFieldInputSchema, { path: "company", source }),
          ),
        ).toEqual({ path: "company", ...expected });
      });
    }
  });

  test("an ai source names exactly one of prompt and adapt", () => {
    // The two halves are separate derived sources in the manifest, so the one
    // combination the union can still spell is refused here.
    const both = v.safeParse(templateFieldInputSchema, {
      path: "recitals",
      source: { type: "ai", prompt: "Draft it", adapt: true },
    });
    expect(both.success).toBe(false);
    expect(
      both.issues?.some((issue) => issue.path?.at(-1)?.key === "source"),
    ).toBe(true);

    const neither = v.safeParse(templateFieldInputSchema, {
      path: "recitals",
      source: { type: "ai", sees_document: true },
    });
    expect(neither.success).toBe(false);
  });

  test("a second source type cannot be sent alongside the first", () => {
    // What used to be six mutually exclusive optionals is one property: a
    // second source is not a conflicting key, it is an unknown one.
    const parsed = v.safeParse(templateFieldInputSchema, {
      path: "company",
      source: {
        type: "lookup",
        registry: "krs",
        prompt: "Draft the company details",
      },
    });

    expect(parsed.success).toBe(false);
  });

  test("a composite field keeps the person source its parts assemble", () => {
    const bound = v.safeParse(templateFieldInputSchema, {
      path: "property_address",
      parts: [{ key: "street", input_type: "text" }],
      format: "{{street}}",
      source: { type: "contact", field: "address" },
    });
    expect(bound.success).toBe(false);
    expect(
      bound.issues?.some((issue) => issue.path?.at(-1)?.key === "source"),
    ).toBe(true);

    const person = v.safeParse(templateFieldInputSchema, {
      path: "property_address",
      parts: [{ key: "street", input_type: "text" }],
      format: "{{street}}",
      source: { type: "person" },
    });
    expect(person.success).toBe(true);
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
    // Every derived half arrives folded into the one `source` property, never
    // beside it: a manifest that broke the single-source invariant still
    // serializes as exactly one branch.
    expect(censusField.source).toEqual({
      type: "lookup",
      registry: "krs",
      formats: [{ key: "default", template: "[name]" }],
    });
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

    const parsed = parseFieldsOverlay([wireField]);

    expect(parsed.success).toBe(true);
    expect(parsed.output).toEqual({
      template_id: TEMPLATE_ID,
      fields: [
        {
          path: "company",
          input_type: "text",
          required: false,
          source: {
            type: "lookup",
            registry: "krs",
            formats: [{ key: "default", template: "[name]" }],
          },
        },
      ],
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

  test("does not erase null typos borrowed from a different schema level", () => {
    const parsed = parseFieldsOverlay([
      { path: "company", validation: { ai_prompt: null } },
    ]);

    expect(parsed.success).toBe(false);
    expect(
      parsed.issues?.some((issue) => issue.path?.at(-1)?.key === "ai_prompt"),
    ).toBe(true);
  });

  /**
   * The overlay is the level a strict tool-schema client fills in most, so
   * every optional property it declares, at every nesting level, must read a
   * `null` as the omission it means. Driving the table off the schemas
   * themselves keeps it total as properties are added.
   */
  describe("reads null as absence for every declared optional property", () => {
    for (const key of Object.keys(advertised)) {
      if (key === "path") {
        continue;
      }
      test(`fields[].${key}`, () => {
        const withNull = parseFieldsOverlay([{ path: "company", [key]: null }]);
        const omitted = parseFieldsOverlay([{ path: "company" }]);
        expect(withNull.success).toBe(omitted.success);
        expect(withNull.output).toEqual(omitted.output);
      });
    }

    for (const key of Object.keys(
      advertised.validation.wrapped.pipe[0].entries,
    )) {
      test(`fields[].validation.${key}`, () => {
        const withNull = parseFieldsOverlay([
          { path: "company", validation: { [key]: null } },
        ]);
        expect(withNull.success).toBe(true);
        expect(withNull.output).toEqual({
          template_id: TEMPLATE_ID,
          fields: [{ path: "company", validation: {} }],
        });
      });
    }

    for (const key of Object.keys(
      advertised.parts.wrapped.pipe[0].item.entries,
    )) {
      test(`fields[].parts[].${key}`, () => {
        const parsed = parseFieldsOverlay([
          {
            path: "company",
            format: "{{title}}",
            parts: [{ key: "title", input_type: "text", [key]: null }],
          },
        ]);
        // A part's `key` and `input_type` are required, so null stays an error
        // there rather than silently becoming an omitted property.
        expect(parsed.success).toBe(key !== "key" && key !== "input_type");
      });
    }

    test("rejects a null under a key the overlay does not declare", () => {
      const parsed = parseFieldsOverlay([
        { path: "company", optionsFrom: null },
      ]);

      expect(parsed.success).toBe(false);
      expect(
        parsed.issues?.some(
          (issue) => issue.path?.at(-1)?.key === "optionsFrom",
        ),
      ).toBe(true);
    });
  });
});
