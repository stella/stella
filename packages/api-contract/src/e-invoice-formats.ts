// Keep the ZIP scanner's format declarations independent of UI and extraction
// code: literal data only, so every reader of the registry stays a leaf.
//
// - ISDOC 6 invoice (`http://isdoc.cz/namespace/2013`), one XML file.
// - ISDOCX: a ZIP holding the ISDOC invoice, its manifest and supplements.
// - Any XML file. Its reader decides by the root element's namespace: a
//   recognised structured invoice is read as one, any other XML as its text.
export const E_INVOICE_FILE_FORMATS = [
  {
    kind: "isdoc",
    auditFormat: "isdoc",
    label: "ISDOC",
    extensions: [".isdoc"],
    mimeType: "application/x-isdoc",
    mimeAliases: [],
    container: "xml",
  },
  {
    kind: "isdocx",
    auditFormat: "isdocx",
    label: "ISDOCX",
    extensions: [".isdocx"],
    mimeType: "application/x-isdocx",
    mimeAliases: [],
    container: "zip",
  },
  {
    kind: "xml",
    auditFormat: "xml",
    label: "XML",
    extensions: [".xml"],
    mimeType: "application/xml",
    mimeAliases: ["text/xml"],
    container: "xml",
  },
] as const;
