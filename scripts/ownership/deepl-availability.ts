import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "deepl-availability",
  capability:
    "Reading translation provider availability before offering actions",
  owner: [
    "apps/web/src/lib/organization/feature-access/capability-actions.tsx",
  ],
  summary:
    "The shared action resolver reads translation availability before rendering actions. The dialog shares the organization-keyed query while open; in-flight reads complete across toolbar remounts.",
  enforcement: {
    kind: "import",
    specifiers: ["@/lib/deepl/queries"],
    names: ["deepLAvailabilityOptions"],
    allowed: [
      {
        path: "apps/web/src/components/translate-document-dialog.tsx",
        reason:
          "Shares the resolver query while the translation dialog is open.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
