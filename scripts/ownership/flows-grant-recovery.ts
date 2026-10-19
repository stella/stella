import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "flows-grant-recovery",
  capability: "Resuming retained flows work after a principal grant",
  owner: ["apps/api/src/lib/flows/resume-after-grant.ts"],
  summary:
    "Rechecks live membership and grant under the admission lock, constrains sources to the principal's matters, and returns no feature data.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/flows/resume-after-grant"],
    allowed: [
      {
        path: "apps/api/src/lib/flows/grant-recovery.ts",
        reason:
          "Dispatches the committed self-serve grant to its void recovery owner.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
