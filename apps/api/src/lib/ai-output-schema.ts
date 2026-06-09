/**
 * Strict-mode-compatible structured output schemas.
 *
 * OpenAI validates the `Output.object` / `Output.array` response
 * format with `strict: true` (the @ai-sdk/openai default) and rejects
 * any object node that does not carry `additionalProperties: false`.
 * `@valibot/to-json-schema` emits that marker only for
 * `v.strictObject()`, and only on that node, so a single plain
 * `v.object()` anywhere in an output schema 400s every OpenAI call.
 *
 * `strictOutputSchema` replaces `valibotSchema` at `Output.*` call
 * sites (enforced by the `ai-output-strict-schema` lint rule): same
 * conversion and validation, plus a walk that pins
 * `additionalProperties: false` on every object node. Response
 * parsing is unchanged; strictness constrains what the model may
 * generate, not what valibot accepts.
 *
 * Not handled here, by design: OpenAI strict mode also requires the
 * root to be an object and every property to be required, so
 * `v.optional()` fields and non-object roots remain incompatible.
 * Those need a schema redesign (nullable-required fields, object
 * root), not a transform.
 */

import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";
import { toJsonSchema } from "@valibot/to-json-schema";
import { jsonSchema } from "ai";
import type { Schema } from "ai";
import * as v from "valibot";

const strictifyDefinition = (
  definition: JSONSchema7Definition,
): JSONSchema7Definition =>
  typeof definition === "boolean" ? definition : strictifyObjects(definition);

const strictifyRecord = (
  record: Record<string, JSONSchema7Definition>,
): Record<string, JSONSchema7Definition> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      strictifyDefinition(value),
    ]),
  );

const strictifyList = (
  list: readonly JSONSchema7Definition[],
): JSONSchema7Definition[] => list.map(strictifyDefinition);

/**
 * Recursively set `additionalProperties: false` on every object node
 * that does not declare it. Nodes that declare `additionalProperties`
 * themselves (`v.record()`, `v.objectWithRest()`) are left as-is:
 * forcing `false` there would change the schema's meaning, and OpenAI
 * strict mode rejects them either way.
 */
const strictifyObjects = (node: JSONSchema7): JSONSchema7 => {
  const out: JSONSchema7 = { ...node };

  if (out.properties !== undefined) {
    out.properties = strictifyRecord(out.properties);
  }
  if (out.patternProperties !== undefined) {
    out.patternProperties = strictifyRecord(out.patternProperties);
  }
  if (out.$defs !== undefined) {
    out.$defs = strictifyRecord(out.$defs);
  }
  if (out.definitions !== undefined) {
    out.definitions = strictifyRecord(out.definitions);
  }
  if (typeof out.additionalProperties === "object") {
    out.additionalProperties = strictifyObjects(out.additionalProperties);
  }
  if (out.items !== undefined) {
    out.items = Array.isArray(out.items)
      ? strictifyList(out.items)
      : strictifyDefinition(out.items);
  }
  if (out.additionalItems !== undefined) {
    out.additionalItems = strictifyDefinition(out.additionalItems);
  }
  if (out.contains !== undefined) {
    out.contains = strictifyDefinition(out.contains);
  }
  if (out.propertyNames !== undefined) {
    out.propertyNames = strictifyDefinition(out.propertyNames);
  }
  if (out.anyOf !== undefined) {
    out.anyOf = strictifyList(out.anyOf);
  }
  if (out.oneOf !== undefined) {
    out.oneOf = strictifyList(out.oneOf);
  }
  if (out.allOf !== undefined) {
    out.allOf = strictifyList(out.allOf);
  }
  if (out.not !== undefined) {
    out.not = strictifyDefinition(out.not);
  }
  // Conditional applicators (`if`/`then`/`else`) are not handled:
  // @valibot/to-json-schema never emits them, and OpenAI strict mode
  // rejects them anyway.

  const isObjectNode = out.type === "object" || out.properties !== undefined;
  if (isObjectNode && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
};

/**
 * Drop-in replacement for `valibotSchema()` from `@ai-sdk/valibot`
 * for structured output (`Output.object` / `Output.array`) schemas.
 */
export const strictOutputSchema = <TSchema extends v.GenericSchema>(
  schema: TSchema,
): Schema<v.InferOutput<TSchema>> =>
  jsonSchema(strictifyObjects(toJsonSchema(schema)), {
    validate: (value) => {
      const result = v.safeParse(schema, value);
      return result.success
        ? { success: true, value: result.output }
        : { success: false, error: new v.ValiError(result.issues) };
    },
  });
