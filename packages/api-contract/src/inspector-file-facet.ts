/** Canonical file-inspector facet domain shared by state, UI, and broadcast validation. */
export const FILE_FACETS = [
  "preview",
  "attachments",
  "metadata",
  "versions",
  "playbook",
  "anonymization",
] as const;

export type FileFacet = (typeof FILE_FACETS)[number];
