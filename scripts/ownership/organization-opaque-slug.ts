import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "organization-opaque-slug",
  capability: "Generating opaque organization slugs",
  owner: ["packages/auth-model/src/contract.ts"],
  summary:
    "Organization creation and slug changes generate the same org- identifier from one fixed-size random buffer; slug length and character rules come from ORGANIZATION_SLUG_RULES next to it.",
  enforcement: {
    // A second generator needs the lowercase base32 alphabet it encodes with.
    kind: "literal-pattern",
    pattern: "^abcdefghijklmnopqrstuvwxyz234567$",
    allowed: [],
  },
} as const satisfies OwnershipEntry;
