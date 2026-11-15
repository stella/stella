import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "timer-activity-key-authorization",
  capability: "Authorizing a Lock Screen timer key",
  owner: ["apps/api/src/lib/push/timer-activity-actions.ts"],
  summary:
    "A Lock Screen button's key is its request's only credential, so the key is looked up on the owner connection by the phone and person it names; the person's current membership, role and time billing access are checked before anything acts for them.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/push/timer-activity-actions"],
    allowed: [
      {
        path: "apps/api/src/handlers/me/timer-activity-devices/act.ts",
        reason:
          "The Lock Screen button endpoint acts only for the person the key authorizes.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
