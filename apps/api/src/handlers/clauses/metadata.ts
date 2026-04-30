import { toJsonObject, toJsonValue } from "@/api/lib/json-value";
import type { JsonObject } from "@/api/lib/json-value";
import { isRecord } from "@/api/lib/type-guards";

const CLAUSE_METADATA_VERSION = 1;
const CLAUSE_METADATA_KEYS = new Set(["version", "custom"]);

export type ClauseMetadata = {
  version: 1;
  custom: JsonObject;
};

export const isClauseMetadata = (value: unknown): value is ClauseMetadata =>
  isRecord(value) &&
  value["version"] === CLAUSE_METADATA_VERSION &&
  isRecord(value["custom"]);

export const normalizeClauseMetadata = (
  metadata: ClauseMetadata | Record<string, unknown> | null | undefined,
): ClauseMetadata | null | undefined => {
  if (metadata === null || metadata === undefined) {
    return metadata;
  }

  if (isClauseMetadata(metadata)) {
    const custom = toJsonObject(metadata.custom);
    for (const [key, value] of Object.entries(metadata)) {
      if (!CLAUSE_METADATA_KEYS.has(key)) {
        custom[key] = toJsonValue(value);
      }
    }

    return {
      version: CLAUSE_METADATA_VERSION,
      custom,
    };
  }

  return {
    version: CLAUSE_METADATA_VERSION,
    custom: toJsonObject(metadata),
  };
};
