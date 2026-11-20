export const DATA_BOX_FILE_FORMAT = {
  kind: "dataBox",
  mimeAliases: [],
  auditFormat: "data-box",
  label: "ZFO",
  extension: ".zfo",
  mimeType: "application/vnd.software602.filler.form-xml-zip",
} as const;

export const CADES_FILE_FORMAT = {
  kind: "cades",
  auditFormat: "cades",
  label: "P7M",
  extension: ".p7m",
  mimeType: "application/pkcs7-mime",
  mimeAliases: ["application/x-pkcs7-mime"],
} as const;

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [
  DATA_BOX_FILE_FORMAT,
  CADES_FILE_FORMAT,
] as const;

export type LegalFileFormatKind = (typeof LEGAL_FILE_FORMATS)[number]["kind"];
