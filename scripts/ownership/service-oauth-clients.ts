import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "service-oauth-clients",
  capability:
    "Organization-bound service OAuth persistence and resolve auditing",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner exposes bounded service-client reads, transactional lifecycle operations and resolve audit writes. Callers receive no database handle; service organization and actor identities remain bound to authenticated control-plane records.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: [
      "readServiceOAuthClientBinding",
      "createServiceOAuthClient",
      "changeServiceOAuthClient",
      "recordLegalResolveAudit",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/auth/service-client.ts",
        reason: "Resolves verified service claims against their live binding.",
      },
      {
        path: "apps/api/src/scripts/service-oauth-client.ts",
        reason: "Runs explicit audited operator lifecycle commands.",
      },
      {
        path: "apps/api/src/handlers/legal-resolve/routes.ts",
        reason: "Writes response audit records from the authorized principal.",
      },
      {
        path: "apps/api/src/lib/auth/service-client.db.test.ts",
        reason: "Exercises native OAuth lifecycle and durable audit records.",
      },
      {
        path: "apps/api/src/handlers/legal-resolve/service-routes.test.ts",
        reason:
          "Binds response audit fixtures to the owner operation contract.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
