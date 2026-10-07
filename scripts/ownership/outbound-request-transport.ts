import type { OwnershipEntry } from "../ownership-types.ts";

export default {
    id: "outbound-request-transport",
    capability: "Sending bounded outbound requests",
    owner: ["apps/api/src/lib/safe-outbound-fetch.ts"],
    summary:
      "Byte and stream requests carry an issued permit. scripts/outbound-transport-ownership.ts enumerates API transport acquisition against the classified owner census in scripts/outbound-transport-census.ts.",
    enforcement: { kind: "none" },
  } as const satisfies OwnershipEntry;
