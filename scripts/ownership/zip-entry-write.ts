import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "zip-entry-write",
  capability: "Writing entries into zip archives (DOCX, XLSX, ODF, bundles)",
  owner: ["packages/docx-utils/src/zip-entry.ts"],
  summary:
    "JSZip encodes string content in 16 KiB pieces, so a character outside " +
    "the Basic Multilingual Plane (emoji, rare CJK) that straddles a piece " +
    "boundary is saved as two U+FFFD. `writeZipEntry` UTF-8 encodes text in " +
    "one pass and hands JSZip bytes; every archive writer goes through it.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-string-zip-entry/no-string-zip-entry",
    reason:
      "JSZip's write and read forms share the `file` method name; the guard " +
      "tells them apart by argument count and skips Bun.file.",
  },
} as const satisfies OwnershipEntry;
