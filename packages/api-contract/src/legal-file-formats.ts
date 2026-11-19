export const DATA_BOX_FILE_FORMAT = {
  kind: "dataBox",
  label: "ZFO",
  extension: ".zfo",
  mimeType: "application/vnd.software602.filler.form-xml-zip",
} as const;

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [DATA_BOX_FILE_FORMAT] as const;

export type LegalFileFormatKind = (typeof LEGAL_FILE_FORMATS)[number]["kind"];
