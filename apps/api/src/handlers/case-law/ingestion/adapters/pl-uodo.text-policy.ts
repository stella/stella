/** The portal republishes these court records as references without their text. */
export const plUodoIsCourtReference = (sourceDocumentId: string): boolean =>
  sourceDocumentId.startsWith("urn:ndoc:court:pl:");
