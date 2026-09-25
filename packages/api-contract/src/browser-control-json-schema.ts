import { toStandardJsonSchema } from "@valibot/to-json-schema";

import {
  browserControlCommandSchema,
  browserControlResultSchema,
} from "./browser-control";
import { keepUnicodePatternSource } from "./json-schema-regex";

type StandardJsonSchema = ReturnType<typeof toStandardJsonSchema>;
type JsonSchemaOptions = Parameters<
  StandardJsonSchema["~standard"]["jsonSchema"]["input"]
>[0];

const withLibraryOptions = (options: JsonSchemaOptions): JsonSchemaOptions => ({
  ...options,
  libraryOptions: {
    ...options.libraryOptions,
    overrideAction: keepUnicodePatternSource,
  },
});

const toContractJsonSchema = <
  TSchema extends Parameters<typeof toStandardJsonSchema>[0],
>(
  schema: TSchema,
) => {
  const standard = toStandardJsonSchema(schema);
  return {
    "~standard": {
      ...standard["~standard"],
      jsonSchema: {
        input: (options: JsonSchemaOptions) =>
          standard["~standard"].jsonSchema.input(withLibraryOptions(options)),
        output: (options: JsonSchemaOptions) =>
          standard["~standard"].jsonSchema.output(withLibraryOptions(options)),
      },
    },
  } satisfies typeof standard;
};

export const browserControlCommandJsonSchema = toContractJsonSchema(
  browserControlCommandSchema,
);
export const browserControlResultJsonSchema = toContractJsonSchema(
  browserControlResultSchema,
);
