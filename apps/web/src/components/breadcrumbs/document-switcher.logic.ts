type DocumentFile = { entityId: string; fieldId: string };

export const isCurrentDocument = (file: DocumentFile, current: DocumentFile) =>
  file.entityId === current.entityId && file.fieldId === current.fieldId;
