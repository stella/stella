// National signed containers that predate ASiC. Keep these declarations
// independent of UI and extraction code, like the ZIP scanner's other formats.
export const SIGNED_DOSSIER_FORMATS = [
  {
    // Microsec e-akta: an XML dossier of embedded documents and XAdES
    // signatures. `.et3` is its delivery receipt and `.dosszie` the name
    // another Hungarian signing client saves the same dossier under.
    kind: "eAkta",
    container: "xml",
    auditFormat: "e-akta",
    label: "ES3",
    extensions: [".es3", ".et3", ".dosszie"],
    mimeType: "application/vnd.eszigno3+xml",
    mimeAliases: [],
  },
  {
    // Slovak ZEPf: a ZIP of external signatures over a MIME envelope that
    // holds the signed documents.
    kind: "zep",
    container: "zip",
    auditFormat: "zep",
    label: "ZEP",
    extensions: [".zep"],
    mimeType: "application/x-zipzepf",
    mimeAliases: ["application/zep"],
  },
] as const;
