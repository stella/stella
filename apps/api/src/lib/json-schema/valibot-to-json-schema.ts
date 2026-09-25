import {
  type ConversionConfig,
  toJsonSchema as convertToJsonSchema,
  type JsonSchema,
} from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

import { keepUnicodePatternSource } from "@stll/api-contract/json-schema-regex";

/** The `v.metadata` keys that are JSON Schema annotations. */
const JSON_SCHEMA_METADATA_KEYS = new Set(["title", "description", "examples"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `@valibot/to-json-schema` copies every `v.metadata` key onto the emitted
 * node. Our metadata also carries internal annotations (`chatProjection`),
 * which must not reach an MCP client, a model provider, or a published
 * contract, so only the keys JSON Schema defines survive.
 */
const stripInternalMetadata: NonNullable<
  ConversionConfig["overrideAction"]
> = ({ valibotAction, jsonSchema }) => {
  if (valibotAction.type !== "metadata" || !("metadata" in valibotAction)) {
    return undefined;
  }
  const { metadata } = valibotAction;
  if (!isRecord(metadata)) {
    return undefined;
  }
  const internalKeys = new Set(
    Object.keys(metadata).filter((key) => !JSON_SCHEMA_METADATA_KEYS.has(key)),
  );
  if (internalKeys.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(jsonSchema).filter(([key]) => !internalKeys.has(key)),
  );
};

type ValibotJsonSchemaConfig = Omit<ConversionConfig, "overrideAction">;

/**
 * The only sanctioned Valibot to JSON Schema conversion in the API; a lint
 * rule bans importing the converter anywhere else.
 */
export const toJsonSchema = (
  schema: GenericSchema,
  config?: ValibotJsonSchemaConfig,
): JsonSchema =>
  convertToJsonSchema(schema, {
    ...config,
    overrideAction: (context) =>
      stripInternalMetadata(context) ?? keepUnicodePatternSource(context),
  });
