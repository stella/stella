import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema, InferInput, InferOutput } from "valibot";

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
          strictifyJsonSchema(
            standardSchema["~standard"].jsonSchema.input(options),
          ),
        output: (options) =>
          strictifyJsonSchema(
            standardSchema["~standard"].jsonSchema.output(options),
          ),
      },
    },
  };
};
