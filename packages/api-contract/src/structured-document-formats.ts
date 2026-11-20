// Keep the ZIP scanner's format declarations independent of UI and extraction code.
export const STRUCTURED_DOCUMENT_FORMATS = [
  {
    kind: "uyap",
    auditFormat: "uyap",
    label: "UDF",
    extensions: [".udf"],
    mimeType: "application/x-uyap-udf",
    mimeAliases: [],
  },
  {
    kind: "ofd",
    auditFormat: "ofd",
    label: "OFD",
    extensions: [".ofd"],
    mimeType: "application/ofd",
    mimeAliases: [],
  },
] as const;
