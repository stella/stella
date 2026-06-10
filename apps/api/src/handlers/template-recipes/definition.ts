import * as v from "valibot";

import { isFieldPath } from "@stll/template-conditions";

import {
  DATE_FORMAT_STYLES,
  INPUT_TYPES,
  LOOKUP_REGISTRIES,
} from "@/api/handlers/docx/types";
import { LIMITS } from "@/api/lib/limits";

/**
 * A template recipe is a saved structural block: a snapshot of pre-configured
 * field metadata (a `FieldMeta` subset), optionally wrapped in a `{{#each}}`
 * loop. Inserting a recipe into a template drops the markers into the document
 * and registers these field configs in the authoring session.
 *
 * Validated with Valibot at the API boundary; the constraints mirror
 * `isFieldMeta` in `@/api/handlers/docx/types` (paths and part keys must
 * satisfy the marker grammar's `isFieldPath`, `parts` and `format` describe
 * one composite value together).
 */

const fieldPathSchema = v.pipe(
  v.string(),
  v.maxLength(256),
  v.check(isFieldPath, "Invalid field path"),
);

const recipeFieldPartSchema = v.strictObject({
  key: fieldPathSchema,
  label: v.optional(v.pipe(v.string(), v.maxLength(256))),
  inputType: v.picklist(["text", "select"]),
  options: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(512))),
      v.maxLength(LIMITS.templateRecipeFieldsMax),
    ),
  ),
  pattern: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

const recipeLookupSchema = v.strictObject({
  registry: v.picklist(LOOKUP_REGISTRIES),
  aiFormat: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});

const recipeFieldSchema = v.pipe(
  v.strictObject({
    path: fieldPathSchema,
    label: v.optional(v.pipe(v.string(), v.maxLength(256))),
    inputType: v.optional(v.picklist(INPUT_TYPES)),
    options: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.maxLength(512))),
        v.maxLength(LIMITS.templateRecipeFieldsMax),
      ),
    ),
    required: v.optional(v.boolean()),
    aiPrompt: v.optional(v.pipe(v.string(), v.maxLength(4000))),
    aiAdapt: v.optional(v.boolean()),
    parts: v.optional(
      v.pipe(
        v.array(recipeFieldPartSchema),
        v.minLength(1),
        v.maxLength(LIMITS.templateRecipeFieldsMax),
      ),
    ),
    format: v.optional(v.pipe(v.string(), v.maxLength(2000))),
    optionsFrom: v.optional(fieldPathSchema),
    lookup: v.optional(recipeLookupSchema),
    hint: v.optional(v.pipe(v.string(), v.maxLength(200))),
    dateFormat: v.optional(
      v.strictObject({
        locale: v.pipe(v.string(), v.maxLength(35)),
        style: v.picklist(DATE_FORMAT_STYLES),
      }),
    ),
  }),
  v.check(
    (field) => (field.parts === undefined) === (field.format === undefined),
    "parts and format must be present together",
  ),
);

export const templateRecipeDefinitionSchema = v.strictObject({
  fields: v.pipe(
    v.array(recipeFieldSchema),
    v.minLength(1),
    v.maxLength(LIMITS.templateRecipeFieldsMax),
  ),
  loop: v.optional(v.strictObject({ path: fieldPathSchema })),
});

export type TemplateRecipeDefinition = v.InferOutput<
  typeof templateRecipeDefinitionSchema
>;
