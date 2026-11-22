import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "file-text-decoding",
  capability:
    "Reading a file's bytes as text in the charset they were written in",
  owner: [
    "packages/mojibake/src/declared-charset.ts",
    "packages/mojibake/src/undeclared-charset.ts",
  ],
  summary:
    "decodeDeclared honours a byte-order mark, a declared charset and an " +
    "in-document declaration, and reads bytes that declare none as UTF-8 " +
    "when they are UTF-8, else as the legacy charset whose reading the " +
    "CLDR exemplar letters explain best. A lenient TextDecoder on a user's " +
    "file turns windows-1250 or windows-1252 text into U+FFFD; the " +
    "lenient-text-decoders ratchet counts older lenient decoders and permits " +
    "only shrinkage outside this owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
