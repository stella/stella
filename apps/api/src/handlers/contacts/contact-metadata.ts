import type { ContactMetadata } from "@/api/db/schema-validators";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeContactMetadata = (
  metadata: ContactMetadata | null | undefined,
) => {
  if (!metadata) {
    return metadata;
  }

  const normalized: ContactMetadata = {};

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
  current: Record<string, unknown> | null | undefined,
  metadata: ContactMetadata | null | undefined,
): Record<string, unknown> | null | undefined => {
  const normalized = normalizeContactMetadata(metadata);
  if (!normalized) {
    return normalized;
  }

  return {
    ...(isRecord(current) ? current : {}),
    ...normalized,
  };
};
