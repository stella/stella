export const DATA_BOX_FILE_FORMAT = {
  kind: "dataBox",
  mimeAliases: [],
  auditFormat: "data-box",
  label: "ZFO",
  extensions: [".zfo"],
  mimeType: "application/vnd.software602.filler.form-xml-zip",
} as const;

export const CADES_FILE_FORMAT = {
  kind: "cades",
  auditFormat: "cades",
  label: "P7M",
  extensions: [".p7m"],
  mimeType: "application/pkcs7-mime",
  mimeAliases: ["application/x-pkcs7-mime"],
} as const;

export const ASIC_E_FILE_FORMAT = {
  kind: "asicE",
  auditFormat: "asic-e",
  label: "ASiC-E",
  extensions: [".asice", ".sce", ".bdoc"],
  mimeType: "application/vnd.etsi.asic-e+zip",
  mimeAliases: [],
} as const;

export const ASIC_S_FILE_FORMAT = {
  kind: "asicS",
  auditFormat: "asic-s",
  label: "ASiC-S",
  extensions: [".asics", ".scs"],
  mimeType: "application/vnd.etsi.asic-s+zip",
  mimeAliases: [],
} as const;

export const ASIC_FILE_FORMATS = [
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
] as const;

export const ASIC_FILE_KINDS = ASIC_FILE_FORMATS.map(({ kind }) => kind);

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [
  DATA_BOX_FILE_FORMAT,
  CADES_FILE_FORMAT,
  ...ASIC_FILE_FORMATS,
] as const;

export type LegalFileFormatKind = (typeof LEGAL_FILE_FORMATS)[number]["kind"];
