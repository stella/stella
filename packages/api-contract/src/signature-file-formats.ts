/**
 * Signature files read by name, and the names a signature is only claimed by
 * once its bytes say so. A `.sig` file may be a PGP or vendor signature and an
 * `.xml` file is usually a plain document, so neither is ever a signature by
 * name alone.
 */
export const SIGNATURE_FILE_FORMATS = [
  {
    kind: "cadesDetached",
    auditFormat: "cades-detached",
    label: "P7S",
    extensions: [".p7s"],
    mimeType: "application/pkcs7-signature",
    mimeAliases: ["application/x-pkcs7-signature"],
  },
  {
    kind: "xades",
    auditFormat: "xades",
    label: "XAdES",
    extensions: [".xades"],
    mimeType: "application/x-xades+xml",
    mimeAliases: [],
  },
] as const;

export type SignatureFileFormatKind =
  (typeof SIGNATURE_FILE_FORMATS)[number]["kind"];

export const SIGNATURE_FILE_KINDS = SIGNATURE_FILE_FORMATS.map(
  ({ kind }) => kind,
);

/** Names whose bytes decide whether the file is a signature of that kind. */
export const SIGNATURE_CONTENT_CANDIDATES = [
  { kind: "cadesDetached", extensions: [".sig"], mimeTypes: [] },
  {
    kind: "xades",
    extensions: [".xml"],
    mimeTypes: ["application/xml", "text/xml"],
  },
] as const satisfies readonly {
  kind: SignatureFileFormatKind;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}[];
