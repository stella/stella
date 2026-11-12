type DocumentFile = { entityId: string; fieldId: string };

export const isCurrentDocument = (file: DocumentFile, current: DocumentFile) =>
  file.entityId === current.entityId && file.fieldId === current.fieldId;

// A file with no alternative renditions still downloads its original bytes, so
// an empty rendition list is a successful read, not an empty state.
export const RENDITION_LIST_VIEW = { isEmpty: () => false } as const;
