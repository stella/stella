import { OUTBOUND_PERMIT_GRANT_OWNERS } from "../outbound-transport-census.ts";
import type { OwnershipEntry } from "../ownership-types.ts";

export default {
    id: "third-party-outbound-permit",
    capability: "Issuing third-party request authority",
    owner: ["apps/api/src/lib/auth/third-party-outbound-permit.ts"],
    summary:
      "Direct request, job and operator boundaries issue the identities checked by the shared outbound request owner.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/auth/third-party-outbound-permit"],
      names: ["grantThirdPartyOutboundPermit"],
      allowed: OUTBOUND_PERMIT_GRANT_OWNERS,
    },
  } as const satisfies OwnershipEntry;
