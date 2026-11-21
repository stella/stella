// Keep the ZIP scanner's format declarations independent of UI and extraction code.

/** Czech ISDOC 6 invoice (`http://isdoc.cz/namespace/2013`), one XML file. */
export const ISDOC_FILE_FORMAT = {
  kind: "isdoc",
  auditFormat: "isdoc",
  label: "ISDOC",
  extensions: [".isdoc"],
  mimeType: "application/x-isdoc",
  mimeAliases: [],
} as const;

/** ISDOC 6 package: a ZIP holding the invoice, its manifest and supplements. */
export const ISDOCX_FILE_FORMAT = {
  kind: "isdocx",
  auditFormat: "isdocx",
  label: "ISDOCX",
  extensions: [".isdocx"],
  mimeType: "application/x-isdocx",
  mimeAliases: [],
} as const;

/**
 * Any XML file. Its reader decides by the root element's namespace, so only a
 * recognised structured invoice is read as one; other XML is never claimed.
 */
export const XML_FILE_FORMAT = {
  kind: "xml",
  auditFormat: "xml",
  label: "XML",
  extensions: [".xml"],
  mimeType: "application/xml",
  mimeAliases: ["text/xml"],
} as const;

export const E_INVOICE_FILE_FORMATS = [
  ISDOC_FILE_FORMAT,
  ISDOCX_FILE_FORMAT,
  XML_FILE_FORMAT,
] as const;
