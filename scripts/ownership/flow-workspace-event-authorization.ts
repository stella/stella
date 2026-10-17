import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "flow-workspace-event-authorization",
  capability: "Authorizing flow workspace event recipients",
  owner: ["apps/api/src/lib/flows/workspace-event-authorizer.ts"],
  summary:
    "Binds event delivery to the owner connection before any request-scoped transaction exists. The delivery operation checks current matter access and feature admission; callers receive neither a connection nor recipient data.",
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
