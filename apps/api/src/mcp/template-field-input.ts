/**
 * Snake_case MCP surface for `save_template`'s `fields` overlay. Advertised
 * tool inputs are snake_case, while the persisted field model is camelCase and
 * shared with the rest of the API and web, so the two cannot be the same
 * schema. Leaf validators, picklists and descriptions are reused from the
 * persisted schemas; only the key spelling differs.
 */

import * as v from "valibot";

import type {
  FieldPart,
  FieldValidation,
  fieldMetaToolInputSchema,
} from "@/api/lib/docx/types";
import {
  describeDerivedSourceConflict,
  FIELD_PARTS_DESCRIPTION,
  FIELD_VALIDATION_DESCRIPTION,
  fieldMetaToolInputObjectSchema,
  fieldPartSchema,
  fieldValidationObjectSchema,
  hasCompatibleDerivedSources,
  hasCompleteCompositeField,
} from "@/api/lib/docx/types";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const { entries: fieldEntries } = fieldMetaToolInputObjectSchema;
const { entries: partEntries } = fieldPartSchema;
const { entries: validationEntries } = fieldValidationObjectSchema;

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
  ai_prompt: fieldEntries.aiPrompt,
  ai_adapt: fieldEntries.aiAdapt,
  ai_sees_document: fieldEntries.aiSeesDocument,
  parts: v.optional(
    v.pipe(
      v.array(templateFieldPartInputSchema),
      v.minLength(1),
      v.description(FIELD_PARTS_DESCRIPTION),
    ),
  ),
  format: fieldEntries.format,
  options_from: fieldEntries.optionsFrom,
  lookup: fieldEntries.lookup,
  source: fieldEntries.source,
  formula: fieldEntries.formula,
  condition: fieldEntries.condition,
  date_format: fieldEntries.dateFormat,
});

/**
 * Declared property names per level of a `fields` entry, read off the schemas
 * themselves so {@link readTemplateFieldsInput} cannot drift from what the
 * surface accepts.
 */
const FIELD_PROPERTIES = new Set(
  Object.keys(templateFieldInputObjectSchema.entries),
);
const VALIDATION_PROPERTIES = new Set(
  Object.keys(templateFieldValidationInputSchema.entries),
);
const PART_PROPERTIES = new Set(
  Object.keys(templateFieldPartInputSchema.entries),
);

const withoutDeclaredNullProperties = (
  entry: Record<string, unknown>,
  declaredProperties: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(entry).filter(
      ([key, value]) => value !== null || !declaredProperties.has(key),
    ),
  );

/** Drop null only at the three schema levels where it means an omitted
 * optional field. Nested lookup/source/date-format objects keep their values,
 * so strict validation still reports a misplaced key even when it is null. */
const withoutNullProperties = (entry: Record<string, unknown>): unknown => {
  const field = withoutDeclaredNullProperties(entry, FIELD_PROPERTIES);
  if (isRecord(field["validation"])) {
    field["validation"] = withoutDeclaredNullProperties(
      field["validation"],
      VALIDATION_PROPERTIES,
    );
  }
  if (isUnknownArray(field["parts"])) {
    field["parts"] = field["parts"].map((part) =>
      isRecord(part)
        ? withoutDeclaredNullProperties(part, PART_PROPERTIES)
        : part,
    );
  }
  return field;
};

/**
 * Normalise a raw `fields` argument before validation: GPT-family clients send
 * `null` for an optional property they are not setting, and null is absence on
 * this surface. Without this, `ai_prompt: null` reads as an AI-drafted field
 * and collides with every other derived source, and `options_from: null` fails
 * the field-path check — a request that set none of them.
 *
 * Only DECLARED properties are dropped, so `strictObject` still rejects a
 * misspelled key whatever value it carries.
 */
export const readTemplateFieldsInput = (value: unknown): unknown =>
  isUnknownArray(value)
    ? value.map((entry) =>
        isRecord(entry) ? withoutNullProperties(entry) : entry,
      )
    : value;

export const templateFieldInputSchema = v.pipe(
  templateFieldInputObjectSchema,
  v.check(
    (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
      hasCompleteCompositeField(field),
    "parts and format must be provided together",
  ),
  v.check(
    (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
      hasCompatibleDerivedSources(toDerivedSourceFields(field)),
    (issue) =>
      describeDerivedSourceConflict(
        toDerivedSourceFields(issue.input),
        "snake",
      ),
  ),
);

/** The snake_case entry read through the shared camelCase derived-source
 *  predicate and message. `path` travels with it so a rejection names the field
 *  as well as the colliding properties. */
const toDerivedSourceFields = ({
  ai_adapt,
  ai_prompt,
  condition,
  formula,
  lookup,
  parts,
  path,
  source,
}: v.InferOutput<typeof templateFieldInputObjectSchema>) => ({
  aiAdapt: ai_adapt,
  aiPrompt: ai_prompt,
  condition,
  formula,
  lookup,
  parts,
  path,
  source,
});

type TemplateFieldInput = v.InferOutput<typeof templateFieldInputSchema>;
type TemplateFieldPartInput = v.InferOutput<
  typeof templateFieldPartInputSchema
>;
type TemplateFieldValidationInput = v.InferOutput<
  typeof templateFieldValidationInputSchema
>;

type PersistedFieldInput = v.InferOutput<typeof fieldMetaToolInputSchema>;

const FIELD_WIRE_KEYS = {
  path: "path",
  label: "label",
  hint: "hint",
  inputType: "input_type",
  options: "options",
  validation: "validation",
  required: "required",
  aiPrompt: "ai_prompt",
  aiAdapt: "ai_adapt",
  aiSeesDocument: "ai_sees_document",
  parts: "parts",
  format: "format",
  optionsFrom: "options_from",
  lookup: "lookup",
  source: "source",
  formula: "formula",
  condition: "condition",
  dateFormat: "date_format",
} as const satisfies Record<
  keyof PersistedFieldInput,
  keyof TemplateFieldInput
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
 * `null` for absent values, while save_template treats null as absence. */
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

/** Serialize a persisted/describe field onto save_template's snake_case wire
 * contract. Null describe values are omitted, producing an object the strict
 * overlay schema accepts without client-side key translation. */
export const toTemplateFieldWireInput = (
  field: DescribedFieldInput,
): TemplateFieldInput => ({
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
  ...(field.aiPrompt === null || field.aiPrompt === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.aiPrompt]: field.aiPrompt }),
  ...(field.aiAdapt === null || field.aiAdapt === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.aiAdapt]: field.aiAdapt }),
  ...(field.aiSeesDocument === null || field.aiSeesDocument === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.aiSeesDocument]: field.aiSeesDocument }),
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
  ...(field.lookup === null || field.lookup === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.lookup]: field.lookup }),
  ...(field.source === null || field.source === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.source]: field.source }),
  ...(field.formula === null || field.formula === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.formula]: field.formula }),
  ...(field.condition === null || field.condition === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.condition]: field.condition }),
  ...(field.dateFormat === null || field.dateFormat === undefined
    ? {}
    : { [FIELD_WIRE_KEYS.dateFormat]: field.dateFormat }),
});

/** Deserialize save_template's wire field through the same total key map used
 * by the describe serializer. */
export const toFieldMetaToolInput = ({
  [FIELD_WIRE_KEYS.validation]: validation,
  [FIELD_WIRE_KEYS.parts]: parts,
  ...field
}: TemplateFieldInput): v.InferOutput<typeof fieldMetaToolInputSchema> => ({
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
  ...(field[FIELD_WIRE_KEYS.aiPrompt] === undefined
    ? {}
    : { aiPrompt: field[FIELD_WIRE_KEYS.aiPrompt] }),
  ...(field[FIELD_WIRE_KEYS.aiAdapt] === undefined
    ? {}
    : { aiAdapt: field[FIELD_WIRE_KEYS.aiAdapt] }),
  ...(field[FIELD_WIRE_KEYS.aiSeesDocument] === undefined
    ? {}
    : { aiSeesDocument: field[FIELD_WIRE_KEYS.aiSeesDocument] }),
  ...(parts === undefined ? {} : { parts: parts.map(toFieldPart) }),
  ...(field[FIELD_WIRE_KEYS.format] === undefined
    ? {}
    : { format: field[FIELD_WIRE_KEYS.format] }),
  ...(field[FIELD_WIRE_KEYS.optionsFrom] === undefined
    ? {}
    : { optionsFrom: field[FIELD_WIRE_KEYS.optionsFrom] }),
  ...(field[FIELD_WIRE_KEYS.lookup] === undefined
    ? {}
    : { lookup: field[FIELD_WIRE_KEYS.lookup] }),
  ...(field[FIELD_WIRE_KEYS.source] === undefined
    ? {}
    : { source: field[FIELD_WIRE_KEYS.source] }),
  ...(field[FIELD_WIRE_KEYS.formula] === undefined
    ? {}
    : { formula: field[FIELD_WIRE_KEYS.formula] }),
  ...(field[FIELD_WIRE_KEYS.condition] === undefined
    ? {}
    : { condition: field[FIELD_WIRE_KEYS.condition] }),
  ...(field[FIELD_WIRE_KEYS.dateFormat] === undefined
    ? {}
    : { dateFormat: field[FIELD_WIRE_KEYS.dateFormat] }),
});
