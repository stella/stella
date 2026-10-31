import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "membership-stewardship-write",
  capability: "Transactional organization role changes under stewardship locks",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "Keeps trusted auth-adapter role writes in the transaction that locks and revalidates the target membership and its matters. Only the auth adapter may supply the write callback; the operation exposes no connection outside that boundary.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["withMemberRoleStewardship"],
    allowed: [
      {
        path: "apps/api/src/lib/auth.ts",
        reason:
          "Binds the trusted framework adapter write to the checked stewardship transaction.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
