export const ASIC_FILE_FORMATS = [
  {
    kind: "asicE",
    auditFormat: "asic-e",
    label: "ASiC-E",
    extensions: [".asice", ".sce", ".bdoc"],
    mimeType: "application/vnd.etsi.asic-e+zip",
    mimeAliases: [],
  },
  {
    kind: "asicS",
    auditFormat: "asic-s",
    label: "ASiC-S",
    extensions: [".asics", ".scs"],
    mimeType: "application/vnd.etsi.asic-s+zip",
    mimeAliases: [],
  },
] as const;
