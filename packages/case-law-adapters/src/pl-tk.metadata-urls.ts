export const PL_TK_METADATA_URL_SCHEMA = {
  caseDocuments: { items: { url: "url" } },
  publications: { items: { links: { items: { url: "url" } } } },
  wordDocumentUrl: "url",
} as const;
