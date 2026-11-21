import { ASIC_FILE_FORMATS } from "./asic-file-formats";
import { SIGNATURE_FILE_FORMATS } from "./signature-file-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "./structured-document-formats";

export const STRUCTURED_DOCUMENT_KINDS = STRUCTURED_DOCUMENT_FORMATS.map(
  ({ kind }) => kind,
);

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

export const [CADES_DETACHED_FILE_FORMAT, XADES_FILE_FORMAT] =
  SIGNATURE_FILE_FORMATS;

export {
  SIGNATURE_FILE_KINDS,
  type SignatureFileFormatKind,
} from "./signature-file-formats";

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [
  DATA_BOX_FILE_FORMAT,
  CADES_FILE_FORMAT,
  ...ASIC_FILE_FORMATS,
  ...SIGNATURE_FILE_FORMATS,
  ...STRUCTURED_DOCUMENT_FORMATS,
] as const;

export type LegalFileFormatKind = (typeof LEGAL_FILE_FORMATS)[number]["kind"];
