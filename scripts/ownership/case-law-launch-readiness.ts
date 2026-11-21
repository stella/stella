import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-launch-readiness",
  capability: "Selecting countries exposed by public case-law surfaces",
  owner: [
    "packages/api-contract/src/case-law-launch-readiness.ts",
    "packages/api-contract/src/launch-readiness.json",
    "apps/web/src/lib/case-law-route.ts",
  ],
  summary:
    "One checked-in inclusion list carries complete readiness evidence for each public country. " +
    "The shared parser rejects incomplete or ambiguous rows, and web and API consumers use the resulting country boundary.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
