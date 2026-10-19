import type { OwnershipEntry } from "../ownership-types";

export default {
  id: "external-service-contracts",
  capability: "Registering external service replay coverage and version pins",
  owner: [
    "packages/external-contracts/",
    "scripts/check-external-contracts.ts",
  ],
  summary:
    "One closed registry assigns outbound owners and external SDKs to service contracts. Offline checks read the real manifest, lockfile, patch, image and API-version pins, compare fixture receipts, and prevent the uncharacterised set from growing.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
