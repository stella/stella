import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "outbound-request-transport",
  capability: "Sending bounded outbound requests",
  owner: ["apps/api/src/lib/safe-outbound-fetch.ts"],
  summary:
    "The auth-free transport core accepts byte and stream requests only from the permit-validating auth facade; public-read requests carry the canonical scope capability. scripts/outbound-transport-ownership.ts enumerates API, collaboration, web and package production transport acquisition against the classified owner census in scripts/outbound-transport-census.ts. API transport capabilities only shrink under the transport ratchet.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
