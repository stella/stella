export const resolveFileFieldPropertyId = ({
  activeFilePropertyId,
  currentFileFieldIdsByProperty,
  fieldId,
  tabPropertyId,
}: {
  activeFilePropertyId: string | undefined;
  currentFileFieldIdsByProperty: ReadonlyMap<string, string>;
  fieldId: string;
  tabPropertyId: string | undefined;
}): string | undefined => {
  if (tabPropertyId !== undefined) {
    return tabPropertyId;
  }
  if (activeFilePropertyId !== undefined) {
    return activeFilePropertyId;
  }

  for (const [propertyId, currentFieldId] of currentFileFieldIdsByProperty) {
    if (currentFieldId === fieldId) {
      return propertyId;
    }
  }
  return undefined;
};
