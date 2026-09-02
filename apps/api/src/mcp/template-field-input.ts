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
  FIELD_PARTS_DESCRIPTION,
  FIELD_VALIDATION_DESCRIPTION,
  fieldMetaToolInputObjectSchema,
  fieldPartSchema,
  fieldValidationObjectSchema,
  hasCompatibleDerivedSources,
  hasCompleteCompositeField,
} from "@/api/lib/docx/types";

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

export const templateFieldInputSchema = v.pipe(
  templateFieldInputObjectSchema,
  v.check(
    (field: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
      hasCompleteCompositeField(field),
    "parts and format must be provided together",
  ),
  v.check(
    ({
      ai_adapt,
      ai_prompt,
      condition,
      formula,
      lookup,
      parts,
      source,
    }: v.InferOutput<typeof templateFieldInputObjectSchema>) =>
      hasCompatibleDerivedSources({
        aiAdapt: ai_adapt,
        aiPrompt: ai_prompt,
        condition,
        formula,
        lookup,
        parts,
        source,
      }),
    "Derived field sources are mutually exclusive",
  ),
);

type TemplateFieldInput = v.InferOutput<typeof templateFieldInputSchema>;
type TemplateFieldPartInput = v.InferOutput<
  typeof templateFieldPartInputSchema
>;
type TemplateFieldValidationInput = v.InferOutput<
  typeof templateFieldValidationInputSchema
>;

const toFieldPart = (part: TemplateFieldPartInput): FieldPart => ({
  key: part.key,
  ...(part.label === undefined ? {} : { label: part.label }),
  inputType: part.input_type,
  ...(part.options === undefined ? {} : { options: part.options }),
  ...(part.pattern === undefined ? {} : { pattern: part.pattern }),
});

const toFieldValidation = (
  validation: TemplateFieldValidationInput,
): FieldValidation => ({
  ...(validation.required === undefined
    ? {}
    : { required: validation.required }),
  ...(validation.min_length === undefined
    ? {}
    : { minLength: validation.min_length }),
  ...(validation.max_length === undefined
    ? {}
    : { maxLength: validation.max_length }),
  ...(validation.min === undefined ? {} : { min: validation.min }),
  ...(validation.max === undefined ? {} : { max: validation.max }),
  ...(validation.pattern === undefined ? {} : { pattern: validation.pattern }),
  ...(validation.min_items === undefined
    ? {}
    : { minItems: validation.min_items }),
  ...(validation.max_items === undefined
    ? {}
    : { maxItems: validation.max_items }),
});

/** The declared return type is the drift guard: a key added to the persisted
 *  tool input has no snake_case source here until it is mapped. */
export const toFieldMetaToolInput = (
  field: TemplateFieldInput,
): v.InferOutput<typeof fieldMetaToolInputSchema> => ({
  path: field.path,
  ...(field.label === undefined ? {} : { label: field.label }),
  ...(field.hint === undefined ? {} : { hint: field.hint }),
  ...(field.input_type === undefined ? {} : { inputType: field.input_type }),
  ...(field.options === undefined ? {} : { options: field.options }),
  ...(field.validation === undefined
    ? {}
    : { validation: toFieldValidation(field.validation) }),
  ...(field.required === undefined ? {} : { required: field.required }),
  ...(field.ai_prompt === undefined ? {} : { aiPrompt: field.ai_prompt }),
  ...(field.ai_adapt === undefined ? {} : { aiAdapt: field.ai_adapt }),
  ...(field.ai_sees_document === undefined
    ? {}
    : { aiSeesDocument: field.ai_sees_document }),
  ...(field.parts === undefined ? {} : { parts: field.parts.map(toFieldPart) }),
  ...(field.format === undefined ? {} : { format: field.format }),
  ...(field.options_from === undefined
    ? {}
    : { optionsFrom: field.options_from }),
  ...(field.lookup === undefined ? {} : { lookup: field.lookup }),
  ...(field.source === undefined ? {} : { source: field.source }),
  ...(field.formula === undefined ? {} : { formula: field.formula }),
  ...(field.condition === undefined ? {} : { condition: field.condition }),
  ...(field.date_format === undefined ? {} : { dateFormat: field.date_format }),
});
