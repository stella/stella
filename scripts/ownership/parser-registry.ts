import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "parser-registry",
  capability: "Case-law parser versions and replay scopes",
  owner: [
    "apps/api/src/lib/legal-search/parser-entries/",
    "scripts/parser-registry.ts",
  ],
  summary:
    "Each parser source owns one entry containing its key, parser version, fingerprint version and replay scope. " +
    "Import-only sources declare their key and fingerprint version. " +
    "A committed typed index inlines validated JSON source entries, keeping the runtime import graph independent of source count. " +
    "Entry changes regenerate the index; conflicts in generated output are resolved by regeneration. " +
    "Parser changes bump only their own version above main's value; the parser-version guard reads entries from each Git tree.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
