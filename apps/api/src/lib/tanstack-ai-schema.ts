import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type { SchemaInput } from "@tanstack/ai";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema, InferInput, InferOutput } from "valibot";

import type { ProviderSafeJsonSchemaProjectionOptions } from "@/api/lib/provider-safe-json-schema";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

export type TanStackValibotSchema<TSchema extends GenericSchema> =
  StandardJSONSchemaV1<InferInput<TSchema>, InferOutput<TSchema>> &
    StandardSchemaV1<InferInput<TSchema>, InferOutput<TSchema>>;

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProjectableJsonSchemaInput = (
  value: SchemaInput | undefined,
): value is StandardJSONSchemaV1 => {
  if (!isJsonObject(value)) {
    return false;
  }
  const schemaObject: JsonObject = value;
  const standard = schemaObject["~standard"];
  if (!isJsonObject(standard)) {
    return false;
  }
  const jsonSchema = standard["jsonSchema"];
  return (
    isJsonObject(jsonSchema) &&
    typeof jsonSchema["input"] === "function" &&
    typeof jsonSchema["output"] === "function"
  );
};

const isStandardSchemaInput = (
  value: SchemaInput | undefined,
): value is StandardSchemaV1 => {
  if (!isJsonObject(value)) {
    return false;
  }
  const schemaObject: JsonObject = value;
  const standard = schemaObject["~standard"];
  return isJsonObject(standard) && typeof standard["validate"] === "function";
};

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

  // Nullable object schemas can arrive as a type union (e.g.
  // ["object", "null"]) before the provider-safe projection lowers them,
  // so match "object" inside arrays too.
  const typeValue = next["type"];
  const isObjectType =
    typeValue === "object" ||
    (Array.isArray(typeValue) && typeValue.includes("object"));
  if (isObjectType && next["additionalProperties"] === undefined) {
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
  options: ProviderSafeJsonSchemaProjectionOptions,
): Record<string, unknown> =>
  projectToProviderSafeJsonSchema(strictifyJsonSchema(schema), options).schema;

export const toTanStackValibotSchema = <TSchema extends GenericSchema>(
  schema: TSchema,
  projectionOptions?: ProviderSafeJsonSchemaProjectionOptions,
): TanStackValibotSchema<TSchema> => {
  const standardSchema = toStandardJsonSchema(schema);
  const providerProjectionOptions = projectionOptions ?? {
    nullUnionStrategy: "json-schema",
  };
  return {
    ...standardSchema,
    "~standard": {
      ...standardSchema["~standard"],
      jsonSchema: {
        input: (options) =>
          toProviderSafeJsonSchema(
            standardSchema["~standard"].jsonSchema.input(options),
            providerProjectionOptions,
          ),
        output: (options) =>
          toProviderSafeJsonSchema(
            standardSchema["~standard"].jsonSchema.output(options),
            providerProjectionOptions,
          ),
      },
    },
  };
};

export const projectSchemaInputJsonSchema = (
  schema: SchemaInput | undefined,
  projectionOptions: ProviderSafeJsonSchemaProjectionOptions,
): SchemaInput | undefined => {
  if (isProjectableJsonSchemaInput(schema)) {
    return {
      ...schema,
      "~standard": {
        ...schema["~standard"],
        jsonSchema: {
          input: (options) =>
            toProviderSafeJsonSchema(
              schema["~standard"].jsonSchema.input(options),
              projectionOptions,
            ),
          output: (options) =>
            toProviderSafeJsonSchema(
              schema["~standard"].jsonSchema.output(options),
              projectionOptions,
            ),
        },
      },
    };
  }

  if (!isJsonObject(schema) || isStandardSchemaInput(schema)) {
    return schema;
  }

  return projectToProviderSafeJsonSchema(schema, projectionOptions).schema;
};
