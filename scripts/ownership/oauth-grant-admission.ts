import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "oauth-grant-admission",
  capability: "OAuth user-grant admission",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner reads one user, organization and client grant's revocation and registration. The admission owner decides OAuth grant admission (revocation by grant id or issue time) for verified tokens and constructs opaque admitted credentials; verification lives in mcp/auth.ts. Consumers receive no owner database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["readOAuthGrantAdmission"],
    allowed: [
      {
        path: "apps/api/src/lib/auth/oauth-grant-admission.ts",
        reason: "Decides grant admission for tokens verified in mcp/auth.ts.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
