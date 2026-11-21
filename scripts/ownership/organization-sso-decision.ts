import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "organization-sso-decision",
  capability: "Organization SSO decision outside a request transaction",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner runs the shared SSO decision from lib/db/sso-access.ts for the auth framework's organization endpoints, for OAuth consent and for signed access tokens, which run outside any request transaction. The guard receives the decision, never the owner database handle; a stored token decides inside the transaction that writes it.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: [
      "readOrganizationRequestSsoRefusal",
      "readConsentSsoAccess",
      "readSignedAccessTokenSsoAccess",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/auth/sso-organization-guard.ts",
        reason:
          "Refuses organization endpoints, OAuth consent and signed access tokens for sessions an organization's SSO requirement does not admit.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
