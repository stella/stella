import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "root-connection-account-export",
  capability: "Account export transactions behind the account fence",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "An account's own export request, read or download opens one transaction: it optionally holds the account's erasure fence on the owner role, then switches to the application role scoped to that account before the export code sees the transaction. Callers receive the scoped transaction, never a connection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["withAccountExportOwnerTransaction"],
    allowed: [
      {
        path: "apps/api/src/lib/account-export/store.ts",
        reason:
          "The account export lifecycle runs an account's own requests, reads and downloads in this transaction.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
