import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "file-encryption",
  capability: "Deciding a stored file's `encrypted` attribute",
  owner: ["apps/api/src/lib/files/detect-file-encryption.ts"],
  summary:
    "Every file content writer takes a `FileEncryption`, which only this " +
    "module makes: from the bytes (PDFs go through the PDF worker), from an " +
    "Office editor's output, from bytes the server built, or from a stored " +
    "copy. The PDF probe is confined here, `no-literal-derived-attribute` " +
    "rejects a literal written to `encrypted` elsewhere in the API, and " +
    "`file-encryption-writers.test.ts` enumerates the writers.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/pdf-utils"],
    names: ["isEncryptedPdf"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
