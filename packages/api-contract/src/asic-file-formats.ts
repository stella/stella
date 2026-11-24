export const ASIC_FILE_FORMATS = [
  {
    kind: "asicE",
    auditFormat: "asic-e",
    label: "ASiC-E",
    extensions: [".asice", ".sce", ".bdoc"],
    mimeType: "application/vnd.etsi.asic-e+zip",
    mimeAliases: [],
    // Estonian BDOC is an ASiC-E profile: the same reader, its own name.
    profiles: [{ label: "BDOC", extensions: [".bdoc"], mark: "bdoc" }],
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
