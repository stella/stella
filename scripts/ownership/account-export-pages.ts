import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "account-export-pages",
  capability:
    "Reading bounded personal export pages across account memberships",
  owner: ["apps/api/src/lib/account-export/pages.ts"],
  summary:
    "The page reader reads export pages under the requesting account's " +
    "row-level scope, independently of an active organization. " +
    "It applies the projection each table owner supplies through the " +
    "composition root; export lifecycle writes remain " +
    "confined to the durable ledger owner.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
