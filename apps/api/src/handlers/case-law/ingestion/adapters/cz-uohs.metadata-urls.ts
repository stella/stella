export const CZ_UOHS_METADATA_URL_SCHEMA = {
  instance: { items: "url" },
  department: { items: "url" },
  proceedingTypes: { items: "url" },
  decisionTypes: { items: "url" },
  documents: { items: { url: "url" } },
} as const;
