type EntityTransfersAvailableOptions = {
  entityIds: readonly string[];
  transfers: readonly { entityId: string; access: string }[] | undefined;
};

export const areEntityTransfersAvailable = ({
  entityIds,
  transfers,
}: EntityTransfersAvailableOptions): boolean => {
  if (entityIds.length === 0 || transfers === undefined) {
    return false;
  }
  const availableIds = new Set(
    transfers
      .filter(({ access }) => access === "available")
      .map(({ entityId }) => entityId),
  );
  return entityIds.every((entityId) => availableIds.has(entityId));
};
