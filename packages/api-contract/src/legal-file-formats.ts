import { ASIC_FILE_FORMATS } from "./asic-file-formats";
import { E_INVOICE_FILE_FORMATS } from "./e-invoice-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "./structured-document-formats";

export const STRUCTURED_DOCUMENT_KINDS = STRUCTURED_DOCUMENT_FORMATS.map(
  ({ kind }) => kind,
);

export const E_INVOICE_KINDS = E_INVOICE_FILE_FORMATS.map(({ kind }) => kind);

export const [ISDOC_FILE_FORMAT, ISDOCX_FILE_FORMAT, XML_FILE_FORMAT] =
  E_INVOICE_FILE_FORMATS;

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

export const [ASIC_E_FILE_FORMAT, ASIC_S_FILE_FORMAT] = ASIC_FILE_FORMATS;

export const ASIC_FILE_KINDS = ASIC_FILE_FORMATS.map(({ kind }) => kind);

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [
  DATA_BOX_FILE_FORMAT,
  CADES_FILE_FORMAT,
  ...ASIC_FILE_FORMATS,
  ...STRUCTURED_DOCUMENT_FORMATS,
  ...E_INVOICE_FILE_FORMATS,
] as const;

export type LegalFileFormat = (typeof LEGAL_FILE_FORMATS)[number];

export type LegalFileFormatKind = LegalFileFormat["kind"];

/**
 * A named variant of a legal format, such as BDOC within ASiC-E: read by the
 * format's own reader, tagged and marked as itself. Its extensions are some
 * of the format's.
 */
export type LegalFileFormatProfile = {
  readonly label: string;
  readonly extensions: readonly string[];
  /** The profile's mark, distinct from the format's. */
  readonly mark: string;
};

export const legalFileFormatProfiles = (
  format: LegalFileFormat,
): readonly LegalFileFormatProfile[] =>
  "profiles" in format ? format.profiles : [];
