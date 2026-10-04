import { isFileProperty } from "@stll/api-contract/property-policy";

export const canEditPropertyViaComposer = (
  content: { type: string },
  isVerdict: boolean,
): boolean => !isFileProperty(content) && !isVerdict;

type EntityIdRow = {
  original: {
    entityId: string;
  };
};

export const getEntityIdsOrderFromRows = (
  rows: readonly EntityIdRow[],
): string[] => {
  const entityIds: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const { entityId } = row.original;
    if (seen.has(entityId)) {
      continue;
    }

    seen.add(entityId);
    entityIds.push(entityId);
  }

  return entityIds;
};
