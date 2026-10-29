// parser-output-unchanged: Extract the existing court-reference predicate for recovery policy reuse; its classification and parser output are unchanged.
/** The portal republishes these court records as references without their text. */
export const plUodoIsCourtReference = (sourceDocumentId: string): boolean =>
  sourceDocumentId.startsWith("urn:ndoc:court:pl:");
