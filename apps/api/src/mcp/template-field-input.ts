/**
 * Snake_case MCP surface for `configure_template_fields`' `fields` entries,
 * and the describe shape `list_templates` and `create_template` hand back.
 * Advertised tool inputs are snake_case, while the persisted field model is
 * camelCase and shared with the rest of the API and web, so the two cannot be
 * the same schema. Leaf validators, picklists and descriptions are reused from
 * the persisted schemas; only the key spelling and the source shape differ.
 *
 * Who fills a field is ONE property. The persisted manifest still carries the
 * flat `aiPrompt` / `lookup` / `source` / `formula` / `condition` keys, but a
 * model driving the tool sees a single discriminated `source` union: it cannot
 * fill six mutually exclusive optionals at once because there is only one
 * property to fill. The describe serializer emits the same union, so a
 * described field is a `configure_template_fields` entry verbatim.
 */

import { panic } from "better-result";
import * as v from "valibot";

import type {
  FieldLookup,
  FieldPart,
  FieldSource,
  FieldValidation,
  fieldMetaToolInputSchema,
} from "@/api/lib/docx/types";
import {
  FIELD_PARTS_DESCRIPTION,
  FIELD_VALIDATION_DESCRIPTION,
  fieldLookupFormatSchema,
  fieldMetaToolInputObjectSchema,
  fieldPartSchema,
  fieldValidationObjectSchema,
  hasCompleteCompositeField,
  LOOKUP_FORMATS_MAX,
  LOOKUP_REGISTRIES,
} from "@/api/lib/docx/types";
import {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";

const { entries: fieldEntries } = fieldMetaToolInputObjectSchema;
const { entries: partEntries } = fieldPartSchema;
const { entries: validationEntries } = fieldValidationObjectSchema;

/**
 * A lookup that names no formats renders the resolved company name through
 * the bare `{{path}}` marker. Spelled once here so the schema's description
 * and the value the mapping substitutes cannot drift.
 */
export const DEFAULT_LOOKUP_FORMAT = {
  key: "name",
  template: "[company name]",
} as const satisfies FieldLookup["formats"][number];

/** Provider-portable single-value enum: JSON Schema `oneOf`/`const` support
 *  is uneven across providers, so each branch's discriminator is a one-value
 *  picklist rather than a literal. */
const sourceType = <TType extends string>(type: TType) => v.picklist([type]);

/**
 * Who fills the field. Exactly one branch, chosen by `type`; omitting `source`
 * altogether means `{ "type": "person" }`.
 *
 * The branches carry no per-property descriptions: ten branches' worth of
 * prose is paid by every MCP client on connect, and the field-configuration
 * reference resource already documents each one in full. The structure is
 * what the schema is for.
 */
const templateFieldSourceInputSchema = v.union([
  v.strictObject({ type: sourceType("person") }),
  v.strictObject({
    type: sourceType("ai"),
    prompt: v.optional(v.string()),
    adapt: v.optional(v.boolean()),
    sees_document: v.optional(v.boolean()),
  }),
  v.strictObject({
    type: sourceType("lookup"),
    registry: v.picklist(LOOKUP_REGISTRIES),
    formats: v.optional(
      v.pipe(
        v.array(fieldLookupFormatSchema),
        v.minLength(1),
        v.maxLength(LOOKUP_FORMATS_MAX),
      ),
    ),
  }),
  v.strictObject({
    type: sourceType("contact"),
    field: v.picklist(CONTACT_FIELDS),
  }),
  v.strictObject({
    type: sourceType("party"),
    role: v.picklist(WORKSPACE_CONTACT_ROLES),
    field: v.picklist(CONTACT_FIELDS),
  }),
  v.strictObject({
    type: sourceType("matter"),
    field: v.picklist(MATTER_FIELDS),
  }),
  v.strictObject({
    type: sourceType("attorney"),
    ref: v.picklist(ATTORNEY_REFS),
    field: v.picklist(USER_FIELDS),
  }),
  v.strictObject({ type: sourceType("firm"), field: v.picklist(FIRM_FIELDS) }),
  v.strictObject({ type: sourceType("formula"), expression: v.string() }),
  v.strictObject({ type: sourceType("condition"), expression: v.string() }),
]);

export type TemplateFieldSourceInput = v.InferOutput<
  typeof templateFieldSourceInputSchema
>;

/** The person branch, spelled once: the default `source`, and what a field
 *  with no derived configuration serializes back to. */
const PERSON_SOURCE = {
  type: "person",
} as const satisfies TemplateFieldSourceInput;

const templateFieldValidationInputSchema = v.pipe(
  v.strictObject({
    required: validationEntries.required,
    min_length: validationEntries.minLength,
    max_length: validationEntries.maxLength,
    min: validationEntries.min,
    max: validationEntries.max,
    pattern: validationEntries.pattern,
    min_items: validationEntries.minItems,
    max_items: validationEntries.maxItems,
  }),
  v.description(FIELD_VALIDATION_DESCRIPTION),
);

const templateFieldPartInputSchema = v.strictObject({
  key: partEntries.key,
  label: partEntries.label,
  input_type: partEntries.inputType,
  options: partEntries.options,
  pattern: partEntries.pattern,
});

const templateFieldInputObjectSchema = v.strictObject({
  path: fieldEntries.path,
  label: fieldEntries.label,
  hint: fieldEntries.hint,
  input_type: fieldEntries.inputType,
  options: fieldEntries.options,
  validation: v.optional(templateFieldValidationInputSchema),
  required: fieldEntries.required,
  parts: v.optional(
    v.pipe(
      v.array(templateFieldPartInputSchema),
      v.minLength(1),
      v.description(FIELD_PARTS_DESCRIPTION),
    ),
  ),
  format: fieldEntries.format,
  options_from: fieldEntries.optionsFrom,
  source: v.optional(
    v.pipe(
      templateFieldSourceInputSchema,
      v.description("Who fills the field; one branch, by type"),
    ),
  ),
  date_format: fieldEntries.dateFormat,
});

/** An `ai` source names exactly one half of the AI contract: a drafting
 *  `prompt` (AI writes the value), or `adapt` (AI rewrites the value the
 *  person entered, per occurrence). The persisted manifest treats the two as
 *  separate derived sources, so a field cannot carry both. */
const hasUsableAiSource = (source: TemplateFieldSourceInput): boolean =>
  source.type !== "ai" ||
  (source.prompt !== undefined) !== (source.adapt === true);

/** A composite field is assembled from its own `parts`, so nothing else may
 *  produce its value. */
const hasCompatibleCompositeSource = ({
  parts,
  source,
}: {
  parts?: readonly unknown[] | undefined;
  source?: TemplateFieldSourceInput | undefined;
}): boolean =>
  parts === undefined || source === undefined || source.type === "person";

export const templateFieldInputSchema = v.pipe(
  templateFieldInputObjectSchema,
  v.check(
    (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
      hasCompleteCompositeField(field),
    "parts and format must be provided together",
  ),
  v.forward(
    v.check(
      (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
        hasCompatibleCompositeSource(field),
      'A composite field is assembled from its parts, so its source must be "person".',
    ),
    ["source"],
  ),
  v.forward(
    v.check(
      (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
        field.source === undefined || hasUsableAiSource(field.source),
      'An "ai" source names exactly one of prompt (AI drafts the value) and adapt: true (AI rewrites the entered value per occurrence).',
    ),
    ["source"],
  ),
);

type TemplateFieldInput = v.InferOutput<typeof templateFieldInputSchema>;

/** A described field: the same entry `configure_template_fields` accepts,
 *  with `source` always spelled out so the caller never has to infer the
 *  default. */
export type DescribedTemplateField = Omit<TemplateFieldInput, "source"> & {
  source: TemplateFieldSourceInput;
};
type TemplateFieldPartInput = v.InferOutput<
  typeof templateFieldPartInputSchema
>;
type TemplateFieldValidationInput = v.InferOutput<
  typeof templateFieldValidationInputSchema
>;

type PersistedFieldInput = v.InferOutput<typeof fieldMetaToolInputSchema>;

/** Persisted properties the wire carries under their own key. The derived
 *  half (`aiPrompt`, `aiAdapt`, `aiSeesDocument`, `lookup`, `source`,
 *  `formula`, `condition`) is folded into `source` instead, and is total over
 *  the union below rather than listed here. */
const FIELD_WIRE_KEYS = {
  path: "path",
  label: "label",
  hint: "hint",
  inputType: "input_type",
  options: "options",
  validation: "validation",
  required: "required",
  parts: "parts",
  format: "format",
  optionsFrom: "options_from",
  dateFormat: "date_format",
} as const satisfies Partial<
  Record<keyof PersistedFieldInput, keyof TemplateFieldInput>
>;

const VALIDATION_WIRE_KEYS = {
  required: "required",
  minLength: "min_length",
  maxLength: "max_length",
  min: "min",
  max: "max",
  pattern: "pattern",
  minItems: "min_items",
  maxItems: "max_items",
} as const satisfies Record<
  keyof FieldValidation,
  keyof TemplateFieldValidationInput
>;

const PART_WIRE_KEYS = {
  key: "key",
  label: "label",
  inputType: "input_type",
  options: "options",
  pattern: "pattern",
} as const satisfies Record<keyof FieldPart, keyof TemplateFieldPartInput>;

/** Camel-case field data returned by the template service. Describe uses
 * `null` for absent values, while the tool treats null as absence. */
type DescribedFieldInput = {
  [Key in keyof PersistedFieldInput]?: PersistedFieldInput[Key] | null;
} & { path: string };

const toFieldPart = (part: TemplateFieldPartInput): FieldPart => ({
  key: part[PART_WIRE_KEYS.key],
  ...(part[PART_WIRE_KEYS.label] === undefined
    ? {}
    : { label: part[PART_WIRE_KEYS.label] }),
  inputType: part[PART_WIRE_KEYS.inputType],
  ...(part[PART_WIRE_KEYS.options] === undefined
    ? {}
    : { options: part[PART_WIRE_KEYS.options] }),
  ...(part[PART_WIRE_KEYS.pattern] === undefined
    ? {}
    : { pattern: part[PART_WIRE_KEYS.pattern] }),
});

const toFieldValidation = (
  validation: TemplateFieldValidationInput,
): FieldValidation => ({
  ...(validation[VALIDATION_WIRE_KEYS.required] === undefined
    ? {}
    : { required: validation[VALIDATION_WIRE_KEYS.required] }),
  ...(validation[VALIDATION_WIRE_KEYS.minLength] === undefined
    ? {}
    : { minLength: validation[VALIDATION_WIRE_KEYS.minLength] }),
  ...(validation[VALIDATION_WIRE_KEYS.maxLength] === undefined
    ? {}
    : { maxLength: validation[VALIDATION_WIRE_KEYS.maxLength] }),
  ...(validation[VALIDATION_WIRE_KEYS.min] === undefined
    ? {}
    : { min: validation[VALIDATION_WIRE_KEYS.min] }),
  ...(validation[VALIDATION_WIRE_KEYS.max] === undefined
    ? {}
    : { max: validation[VALIDATION_WIRE_KEYS.max] }),
  ...(validation[VALIDATION_WIRE_KEYS.pattern] === undefined
    ? {}
    : { pattern: validation[VALIDATION_WIRE_KEYS.pattern] }),
  ...(validation[VALIDATION_WIRE_KEYS.minItems] === undefined
    ? {}
    : { minItems: validation[VALIDATION_WIRE_KEYS.minItems] }),
  ...(validation[VALIDATION_WIRE_KEYS.maxItems] === undefined
    ? {}
    : { maxItems: validation[VALIDATION_WIRE_KEYS.maxItems] }),
});

const toTemplateFieldValidationInput = (
  validation: FieldValidation,
): TemplateFieldValidationInput => ({
  ...(validation.required === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.required]: validation.required }),
  ...(validation.minLength === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.minLength]: validation.minLength }),
  ...(validation.maxLength === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.maxLength]: validation.maxLength }),
  ...(validation.min === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.min]: validation.min }),
  ...(validation.max === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.max]: validation.max }),
  ...(validation.pattern === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.pattern]: validation.pattern }),
  ...(validation.minItems === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.minItems]: validation.minItems }),
  ...(validation.maxItems === undefined
    ? {}
    : { [VALIDATION_WIRE_KEYS.maxItems]: validation.maxItems }),
});

/** The persisted half of a field that says who fills it. Every branch of the
 *  wire union produces exactly one of these shapes. */
type PersistedFieldSourceProperties = Pick<
  PersistedFieldInput,
  "aiAdapt" | "aiPrompt" | "aiSeesDocument" | "condition" | "formula" | "lookup"
> & { source?: FieldSource | undefined };

/** One wire source branch, spread onto the persisted field. Exhaustive over
 *  the union: a new branch is a compile error until it is mapped. */
const toPersistedFieldSource = (
  source: TemplateFieldSourceInput,
): PersistedFieldSourceProperties => {
  switch (source.type) {
    case "person":
      return {};
    case "ai":
      return {
        ...(source.prompt === undefined ? {} : { aiPrompt: source.prompt }),
        ...(source.adapt === undefined ? {} : { aiAdapt: source.adapt }),
        ...(source.sees_document === undefined
          ? {}
          : { aiSeesDocument: source.sees_document }),
      };
    case "lookup":
      return {
        lookup: {
          registry: source.registry,
          formats: source.formats ?? [DEFAULT_LOOKUP_FORMAT],
        },
      };
    case "contact":
      return { source: { kind: "contact", field: source.field } };
    case "party":
      return {
        source: { kind: "party", role: source.role, field: source.field },
      };
    case "matter":
      return { source: { kind: "matter", field: source.field } };
    case "attorney":
      return {
        source: { kind: "attorney", ref: source.ref, field: source.field },
      };
    case "firm":
      return { source: { kind: "firm", field: source.field } };
    case "formula":
      return { formula: source.expression };
    case "condition":
      return { condition: source.expression };
    default: {
      source satisfies never;
      return panic(`Unhandled template field source: ${String(source)}`);
    }
  }
};

/** The persisted binding read back as its own wire branch. Exhaustive over
 *  the binding kinds, so a new kind cannot serialize as something else. */
const toWireBindingSource = (source: FieldSource): TemplateFieldSourceInput => {
  switch (source.kind) {
    case "contact":
      return { type: "contact", field: source.field };
    case "party":
      return { type: "party", role: source.role, field: source.field };
    case "matter":
      return { type: "matter", field: source.field };
    case "attorney":
      return { type: "attorney", ref: source.ref, field: source.field };
    case "firm":
      return { type: "firm", field: source.field };
    default: {
      source satisfies never;
      return panic(`Unhandled binding source: ${String(source)}`);
    }
  }
};

/**
 * Which branch a persisted field serializes back to. The manifest invariant
 * allows at most one derived source, so the order below only decides what a
 * hand-edited manifest that broke that invariant reports; it never masks a
 * second source, because a second source cannot be written through this
 * surface. `aiSeesDocument`/`aiAdapt` default to `false` in the describe
 * payload, which is not a source: only a prompt or `adapt: true` is.
 */
const toWireFieldSource = (
  field: DescribedFieldInput,
): TemplateFieldSourceInput => {
  if (field.lookup !== null && field.lookup !== undefined) {
    return {
      type: "lookup",
      registry: field.lookup.registry,
      formats: field.lookup.formats.map((format) => ({
        key: format.key,
        template: format.template,
      })),
    };
  }
  if (field.source !== null && field.source !== undefined) {
    return toWireBindingSource(field.source);
  }
  if (field.formula !== null && field.formula !== undefined) {
    return { type: "formula", expression: field.formula };
  }
  if (field.condition !== null && field.condition !== undefined) {
    return { type: "condition", expression: field.condition };
  }
  const prompt = field.aiPrompt ?? undefined;
  if (prompt !== undefined || field.aiAdapt === true) {
    return {
      type: "ai",
      ...(prompt === undefined ? {} : { prompt }),
      ...(field.aiAdapt === true ? { adapt: true } : {}),
      ...(field.aiSeesDocument === true ? { sees_document: true } : {}),
    };
  }
  return PERSON_SOURCE;
};

/** Serialize a persisted/describe field onto the tool's snake_case wire
 * contract. Null describe values are omitted, producing an object the strict
 * entry schema accepts without client-side key translation. */
export const toTemplateFieldWireInput = (
  field: DescribedFieldInput,
): DescribedTemplateField => ({
  [FIELD_WIRE_KEYS.path]: field.path,
  ...(field.label === null || field.label === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.label]: field.label }),
  ...(field.hint === null || field.hint === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.hint]: field.hint }),
  ...(field.inputType === null || field.inputType === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.inputType]: field.inputType }),
  ...(field.options === null || field.options === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.options]: field.options }),
  ...(field.validation === null || field.validation === undefined
    ? {}
    : {
        [FIELD_WIRE_KEYS.validation]: toTemplateFieldValidationInput(
          field.validation,
        ),
      }),
  ...(field.required === null || field.required === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.required]: field.required }),
  ...(field.parts === null || field.parts === undefined
    ? {}
    : {
        [FIELD_WIRE_KEYS.parts]: field.parts.map((part) => ({
          [PART_WIRE_KEYS.key]: part.key,
          ...(part.label === undefined
            ? {}
            : { [PART_WIRE_KEYS.label]: part.label }),
          [PART_WIRE_KEYS.inputType]: part.inputType,
          ...(part.options === undefined
            ? {}
            : { [PART_WIRE_KEYS.options]: part.options }),
          ...(part.pattern === undefined
            ? {}
            : { [PART_WIRE_KEYS.pattern]: part.pattern }),
        })),
      }),
  ...(field.format === null || field.format === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.format]: field.format }),
  ...(field.optionsFrom === null || field.optionsFrom === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.optionsFrom]: field.optionsFrom }),
  source: toWireFieldSource(field),
  ...(field.dateFormat === null || field.dateFormat === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.dateFormat]: field.dateFormat }),
});

/** Deserialize a wire field through the same total key map used by the
 * describe serializer. */
export const toFieldMetaToolInput = ({
  [FIELD_WIRE_KEYS.validation]: validation,
  [FIELD_WIRE_KEYS.parts]: parts,
  source,
  ...field
}: TemplateFieldInput): PersistedFieldInput => ({
  path: field[FIELD_WIRE_KEYS.path],
  ...(field[FIELD_WIRE_KEYS.label] === undefined
    ? {}
    : { label: field[FIELD_WIRE_KEYS.label] }),
  ...(field[FIELD_WIRE_KEYS.hint] === undefined
    ? {}
    : { hint: field[FIELD_WIRE_KEYS.hint] }),
  ...(field[FIELD_WIRE_KEYS.inputType] === undefined
    ? {}
    : { inputType: field[FIELD_WIRE_KEYS.inputType] }),
  ...(field[FIELD_WIRE_KEYS.options] === undefined
    ? {}
    : { options: field[FIELD_WIRE_KEYS.options] }),
  ...(validation === undefined
    ? {}
    : { validation: toFieldValidation(validation) }),
  ...(field[FIELD_WIRE_KEYS.required] === undefined
    ? {}
    : { required: field[FIELD_WIRE_KEYS.required] }),
  ...(parts === undefined ? {} : { parts: parts.map(toFieldPart) }),
  ...(field[FIELD_WIRE_KEYS.format] === undefined
    ? {}
    : { format: field[FIELD_WIRE_KEYS.format] }),
  ...(field[FIELD_WIRE_KEYS.optionsFrom] === undefined
    ? {}
    : { optionsFrom: field[FIELD_WIRE_KEYS.optionsFrom] }),
  ...(source === undefined ? {} : toPersistedFieldSource(source)),
  ...(field[FIELD_WIRE_KEYS.dateFormat] === undefined
    ? {}
    : { dateFormat: field[FIELD_WIRE_KEYS.dateFormat] }),
});
