import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "parser-registry",
  capability: "Case-law parser versions and replay scopes",
  owner: [
    "apps/api/src/lib/legal-search/parser-entries/",
    "scripts/parser-registry.ts",
  ],
  summary:
    "Each source owns one entry containing its key, parser version, fingerprint version and replay scope. " +
    "API preparation derives an untracked typed index. Independent source edits never share committed registry lines. " +
    "Parser changes bump only their own version above main's value; the parser-version guard reads entries from each Git tree.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
