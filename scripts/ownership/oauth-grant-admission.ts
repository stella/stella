import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "oauth-grant-admission",
  capability: "OAuth user-grant admission",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner reads one user, organization and client grant's revocation and registration. The admission owner verifies resource tokens and constructs opaque admitted credentials; consumers receive no owner database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["readOAuthGrantAdmission"],
    allowed: [
      {
        path: "apps/api/src/lib/auth/oauth-grant-admission.ts",
        reason:
          "Combines signature verification with grant admission for every OAuth resource.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
