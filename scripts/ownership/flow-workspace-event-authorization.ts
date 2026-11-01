import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "flow-workspace-event-authorization",
  capability: "Authorizing flow workspace event recipients",
  owner: ["apps/api/src/lib/flows/workspace-event-authorizer.ts"],
  summary:
    "Projects live source ownership and recipient feature admission into the session audience query. Event visibility follows the persisted entity read policy; deleted entities retain their transactional classification.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/flows/workspace-event-authorizer"],
    allowed: [
      {
        path: "apps/api/src/lib/auth.ts",
        reason: "Supplies the event stream's current-recipient authorizer.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
