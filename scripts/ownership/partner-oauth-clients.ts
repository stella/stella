import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "partner-oauth-clients",
  capability:
    "Operator-registered partner OAuth clients for hosted assistants without dynamic registration",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner exposes the partner-client kind check and transactional create, rotate and disable operations. Callers receive no database handle; every user of a partner client still signs in and consents.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: [
      "isPartnerOAuthClient",
      "createPartnerOAuthClient",
      "changePartnerOAuthClient",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/auth.ts",
        reason:
          "Targets the MCP resource for partner authorizations that name none.",
      },
      {
        path: "apps/api/src/scripts/partner-oauth-client.ts",
        reason: "Runs explicit audited operator lifecycle commands.",
      },
      {
        path: "apps/api/src/lib/auth/partner-client.db.test.ts",
        reason: "Exercises the partner OAuth lifecycle and its audit records.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
