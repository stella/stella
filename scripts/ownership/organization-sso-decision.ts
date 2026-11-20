import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "organization-sso-decision",
  capability: "Organization SSO decision outside a request transaction",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner runs the shared SSO decision from lib/db/sso-access.ts for the auth framework's organization endpoints and for OAuth consent, which run before any request transaction exists. The guard receives the decision, never the owner database handle; token issuance decides inside its own transaction.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["readOrganizationRequestSsoRefusal", "readConsentSsoAccess"],
    allowed: [
      {
        path: "apps/api/src/lib/auth/sso-organization-guard.ts",
        reason:
          "Refuses organization endpoints and OAuth consent for sessions an organization's SSO requirement does not admit.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
