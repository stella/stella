import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "deepl-availability",
  capability: "Reading translation provider availability on demand",
  owner: ["apps/web/src/components/translate-document-dialog.tsx"],
  summary:
    "The translation dialog starts availability reads only while open. Its shared query factory requires an explicit open state, keys the cache by organization, and lets an in-flight read complete across toolbar remounts.",
  enforcement: {
    kind: "import",
    specifiers: ["@/lib/deepl/queries"],
    names: ["deepLAvailabilityOptions"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
