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

export const shouldReplaceFileFieldAfterSync = ({
  isFieldIdPinned,
  isSelectedFieldMissing,
  previousCurrentFieldId,
  selectedFieldId,
}: {
  isFieldIdPinned: boolean;
  isSelectedFieldMissing: boolean;
  previousCurrentFieldId: string | undefined;
  selectedFieldId: string;
}): boolean =>
  !isFieldIdPinned &&
  (isSelectedFieldMissing || previousCurrentFieldId === selectedFieldId);
