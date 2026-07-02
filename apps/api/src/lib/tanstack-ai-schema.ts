import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema, InferInput, InferOutput } from "valibot";

import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

export type TanStackValibotSchema<TSchema extends GenericSchema> =
  StandardJSONSchemaV1<InferInput<TSchema>, InferOutput<TSchema>> &
    StandardSchemaV1<InferInput<TSchema>, InferOutput<TSchema>>;

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strictifyObjectSchemas = (schema: unknown): unknown => {
  if (!isJsonObject(schema)) {
    return schema;
  }

  const next: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      next[key] = value.map(strictifyObjectSchemas);
      continue;
    }
    next[key] = strictifyObjectSchemas(value);
  }

  if (next["type"] === "object" && next["additionalProperties"] === undefined) {
    next["additionalProperties"] = false;
  }

  return next;
};

const strictifyJsonSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const strictified = strictifyObjectSchemas(schema);
  return isJsonObject(strictified) ? strictified : schema;
};

// Providers (notably Google Gemini) reject tool schemas that carry keywords
// outside their OpenAPI-3.0 subset. Project into the portable subset after
// strictification injects `additionalProperties: false`. Dropped keywords here
// are expected for known valibot shapes (e.g. `v.record` -> `propertyNames`);
// this pure path does not log.
const toProviderSafeJsonSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> =>
  projectToProviderSafeJsonSchema(strictifyJsonSchema(schema)).schema;

export const toTanStackValibotSchema = <TSchema extends GenericSchema>(
  schema: TSchema,
): TanStackValibotSchema<TSchema> => {
  const standardSchema = toStandardJsonSchema(schema);
  return {
    ...standardSchema,
    "~standard": {
      ...standardSchema["~standard"],
      jsonSchema: {
        input: (options) =>
          toProviderSafeJsonSchema(
            standardSchema["~standard"].jsonSchema.input(options),
          ),
        output: (options) =>
          toProviderSafeJsonSchema(
            standardSchema["~standard"].jsonSchema.output(options),
          ),
      },
    },
  };
};
