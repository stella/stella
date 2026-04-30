import type {
  ContactCustomField,
  ContactDataBox,
  ContactMetadata,
  ContactPersistedMetadata,
} from "@/api/db/schema-validators";
import { toJsonObject, toJsonValue } from "@/api/lib/json-value";
import type { JsonObject } from "@/api/lib/json-value";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CONTACT_METADATA_VERSION = 1;
const CONTACT_METADATA_KEYS = new Set(["version", "dataBoxes", "customFields"]);

type ContactMetadataLegacyInput =
  | ContactPersistedMetadata
  | (Record<string, unknown> & { custom?: JsonObject })
  | null
  | undefined;

const isContactDataBox = (value: unknown): value is ContactDataBox =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["isPrimary"] === "boolean" &&
  (value["label"] === undefined || typeof value["label"] === "string");

const isContactCustomField = (value: unknown): value is ContactCustomField =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["label"] === "string" &&
  typeof value["value"] === "string";

const extractKnownFields = (
  current: ContactMetadataLegacyInput,
): ContactMetadata => {
  if (!isRecord(current)) {
    return {};
  }

  const known: ContactMetadata = {};
  if (Array.isArray(current.dataBoxes)) {
    known.dataBoxes = current.dataBoxes.filter(isContactDataBox);
  }
  if (Array.isArray(current.customFields)) {
    known.customFields = current.customFields.filter(isContactCustomField);
  }
  return known;
};

const extractLegacyCustom = (
  current: ContactMetadataLegacyInput,
): JsonObject | undefined => {
  if (!isRecord(current)) {
    return undefined;
  }

  const custom: JsonObject = {};
  if (isRecord(current.custom)) {
    Object.assign(custom, toJsonObject(current.custom));
  }

  for (const [key, value] of Object.entries(current)) {
    if (!CONTACT_METADATA_KEYS.has(key) && key !== "custom") {
      custom[key] = toJsonValue(value);
    }
  }

  return Object.keys(custom).length > 0 ? custom : undefined;
};

export const normalizeContactMetadata = (
  metadata: ContactMetadata | null | undefined,
): ContactPersistedMetadata | null | undefined => {
  if (!metadata) {
    return metadata;
  }

  const normalized: ContactPersistedMetadata = {
    version: CONTACT_METADATA_VERSION,
  };

  if (metadata.dataBoxes !== undefined) {
    normalized.dataBoxes = metadata.dataBoxes.map((dataBox) => ({
      ...dataBox,
      id: dataBox.id.toLowerCase(),
    }));
  }

  if (metadata.customFields !== undefined) {
    normalized.customFields = metadata.customFields;
  }

  return normalized;
};

export const mergeContactMetadata = (
  current: ContactMetadataLegacyInput,
  metadata: ContactMetadata | null | undefined,
): ContactPersistedMetadata | null | undefined => {
  const normalized = normalizeContactMetadata(metadata);
  if (!normalized) {
    return normalized;
  }

  const legacyCustom = extractLegacyCustom(current);
  const knownFields = extractKnownFields(current);

  return {
    ...knownFields,
    ...normalized,
    ...(legacyCustom ? { custom: legacyCustom } : {}),
  };
};
