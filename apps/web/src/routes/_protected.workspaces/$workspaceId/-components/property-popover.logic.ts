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
