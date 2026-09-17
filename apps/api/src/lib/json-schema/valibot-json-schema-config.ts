import type { ConversionConfig } from "@valibot/to-json-schema";

/** The `v.metadata` keys that are JSON Schema annotations. */
const JSON_SCHEMA_METADATA_KEYS = new Set(["title", "description", "examples"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `@valibot/to-json-schema` copies every `v.metadata` key onto the emitted
 * node. Our metadata also carries internal annotations (`chatProjection`),
 * which must not reach an MCP client, a model provider, or a published
 * contract. Keep only the keys JSON Schema defines.
 */
export const stripInternalMetadata: NonNullable<
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
