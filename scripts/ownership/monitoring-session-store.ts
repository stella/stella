import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "monitoring-session-store",
  capability: "Provisioning and revoking dedicated monitoring sessions",
  owner: ["apps/api/src/lib/synthetic-principal/store.ts"],
  summary:
    "The fixed-principal session owner uses the owner connection for auth records and a control table ordinary requests cannot access. Mint and revoke serialize through the control row and audit before commit; no connection is exported.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
