import { ASIC_FILE_FORMATS } from "./asic-file-formats";
import { E_INVOICE_FILE_FORMATS } from "./e-invoice-formats";
import { SIGNED_DOSSIER_FORMATS } from "./signed-dossier-formats";
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

/**
 * A plain ZIP archive. A ZIP-based format its name names (an ASiC container,
 * an ISDOCX invoice, an Office document) is that format instead.
 */
export const ZIP_FILE_FORMAT = {
  kind: "zip",
  auditFormat: "zip",
  label: "ZIP",
  extensions: [".zip"],
  mimeType: "application/zip",
  mimeAliases: ["application/x-zip-compressed"],
} as const;

/**
 * A mailbox: messages one after another, each opened by a `From ` line
 * (RFC 4155), as mail clients and mail exports write them. Every message is
 * a part of the file (`message:N`) and opens as an email of its own.
 */
export const MBOX_FILE_FORMAT = {
  kind: "mbox",
  auditFormat: "mbox",
  label: "MBOX",
  extensions: [".mbox", ".mbx"],
  mimeType: "application/mbox",
  mimeAliases: [],
} as const;

/**
 * An Outlook mailbox file (`.pst`, and `.ost` in the same layout): a store of
 * folders and messages. Every message is a part of the file (`message:N`,
 * numbered down the folders in order) and opens as an email of its own.
 */
export const PST_FILE_FORMAT = {
  kind: "pst",
  auditFormat: "pst",
  label: "PST",
  extensions: [".pst", ".ost"],
  mimeType: "application/vnd.ms-outlook-pst",
  mimeAliases: [],
} as const;

/** Formats whose files are mailboxes: lists of messages, each an email. */
export const MAILBOX_FILE_FORMATS = [
  MBOX_FILE_FORMAT,
  PST_FILE_FORMAT,
] as const;

export const MAILBOX_FILE_KINDS = MAILBOX_FILE_FORMATS.map(({ kind }) => kind);

export const [ASIC_E_FILE_FORMAT, ASIC_S_FILE_FORMAT] = ASIC_FILE_FORMATS;

export const ASIC_FILE_KINDS = ASIC_FILE_FORMATS.map(({ kind }) => kind);

export const [E_AKTA_FILE_FORMAT, ZEP_FILE_FORMAT, XADES_ZEP_FILE_FORMAT] =
  SIGNED_DOSSIER_FORMATS;

export const SIGNED_DOSSIER_KINDS = SIGNED_DOSSIER_FORMATS.map(
  ({ kind }) => kind,
);

/** Recognized legal containers shared by Files, search and chat. */
export const LEGAL_FILE_FORMATS = [
  DATA_BOX_FILE_FORMAT,
  CADES_FILE_FORMAT,
  ...ASIC_FILE_FORMATS,
  ...SIGNED_DOSSIER_FORMATS,
  ...STRUCTURED_DOCUMENT_FORMATS,
  ...E_INVOICE_FILE_FORMATS,
  ZIP_FILE_FORMAT,
  MBOX_FILE_FORMAT,
  PST_FILE_FORMAT,
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
