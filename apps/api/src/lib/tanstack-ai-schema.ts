import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema, InferInput, InferOutput } from "valibot";

export type TanStackValibotSchema<TSchema extends GenericSchema> =
  StandardJSONSchemaV1<InferInput<TSchema>, InferOutput<TSchema>>;

export const toTanStackValibotSchema = <TSchema extends GenericSchema>(
  schema: TSchema,
): TanStackValibotSchema<TSchema> => toStandardJsonSchema(schema);
