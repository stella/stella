export const AT_RIS_METADATA_URL_SCHEMA = {
  decisionTextDocument: "url",
  documentParts: { items: { formats: { items: { url: "url" } } } },
} as const;

export const AT_RIS_HEADNOTE_METADATA_URL_SCHEMA = {
  ...AT_RIS_METADATA_URL_SCHEMA,
  headnotes: { items: { documentUrl: "url" } },
} as const;
