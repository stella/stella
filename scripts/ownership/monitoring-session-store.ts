import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "monitoring-session-store",
  capability: "Provisioning and revoking dedicated sessions",
  owner: ["apps/api/src/lib/synthetic-principal/store.ts"],
  summary: "Owns dedicated-session provisioning and revocation.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
