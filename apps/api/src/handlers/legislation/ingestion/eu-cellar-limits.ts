/** Hard per-document ceilings shared by acquisition, decoding and normalization. */
export const EU_CELLAR_LIMITS = {
  documentBytes: 8 * 1024 * 1024,
  domNodes: 100_000,
  xmlDepth: 64,
  metadataStatements: 20_000,
  rawSnapshotBytes: 64 * 1024 * 1024,
} as const;
