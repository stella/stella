import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type { SchemaInput } from "@tanstack/ai";
import {
  type ConversionConfig,
  toJsonSchema,
  toStandardJsonSchema,
} from "@valibot/to-json-schema";
import { panic } from "better-result";
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
  value: unknown,
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

const isStandardSchemaInput = (value: unknown): value is StandardSchemaV1 => {
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

// Pure string normalization is applied by Valibot after the provider response
// returns. It has no JSON Schema representation, so omit it from the provider
// contract while retaining every representable constraint around it. All
// other unsupported actions still fail conversion at this boundary.
const PROVIDER_SCHEMA_IGNORED_ACTIONS = ["trim"];

const valibotJsonSchemaTarget = (
  target: StandardJSONSchemaV1.Target,
): NonNullable<ConversionConfig["target"]> => {
  if (target === "draft-2020-12") {
    return "draft-2020-12";
  }
  if (target === "openapi-3.0") {
    return "openapi-3.0";
  }
  return "draft-07";
};

// Providers (notably Google Gemini) reject tool schemas that carry keywords
// outside their OpenAPI-3.0 subset. Project into the portable subset after
// strictification injects `additionalProperties: false`. Dropped keywords here
// are expected for known valibot shapes (e.g. `v.record` -> `propertyNames`);
// this pure path does not log.
const toProviderSafeJsonSchema = (
  schema: unknown,
  options: ProviderSafeJsonSchemaProjectionOptions,
): Record<string, unknown> => {
  if (!isJsonObject(schema)) {
    return panic("Valibot produced a non-object JSON Schema");
  }
  return projectToProviderSafeJsonSchema(strictifyJsonSchema(schema), options)
    .schema;
};

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
            toJsonSchema(schema, {
              target: valibotJsonSchemaTarget(options.target),
              typeMode: "input",
              ignoreActions: PROVIDER_SCHEMA_IGNORED_ACTIONS,
            }),
            providerProjectionOptions,
          ),
        output: (options) =>
          toProviderSafeJsonSchema(
            toJsonSchema(schema, {
              target: valibotJsonSchemaTarget(options.target),
              typeMode: "output",
              ignoreActions: PROVIDER_SCHEMA_IGNORED_ACTIONS,
            }),
            providerProjectionOptions,
          ),
      },
    },
  };
};

export const projectSchemaInputJsonSchema = (
  schema: unknown,
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

  if (schema === undefined || isStandardSchemaInput(schema)) {
    return schema;
  }

  if (!isJsonObject(schema)) {
    return undefined;
  }

  return projectToProviderSafeJsonSchema(schema, projectionOptions).schema;
};
