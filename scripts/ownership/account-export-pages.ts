import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "account-export-pages",
  capability:
    "Reading bounded personal export pages across account memberships",
  owner: ["apps/api/src/lib/account-export/pages.ts"],
  summary:
    "The page reader resolves the dedicated RLS transaction pool and binds " +
    "the requesting account independently of an active organization. " +
    "It calls each table owner's projection; export lifecycle writes remain " +
    "confined to the durable ledger owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
