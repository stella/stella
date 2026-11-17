import type { Transaction } from "@/api/db/root";
import type { OrganizationFileDeletionDb } from "@/api/lib/files/organization-file-deletion-db";

import { asTestRaw } from "./helpers/test-tool-set";

// Every query the fence builds resolves to no rows, whatever its chain:
// no requested key belongs to an organization, so no legal hold applies.
// Awaiting the chain reads the settled empty result; any builder step
// (`from`, `where`, `innerJoin`, ...) continues the same chain.
// Typed as `unknown`: the chain is a query-builder stand-in that happens to be
// awaitable, not a promise a caller should treat as one.
const noRows = (): unknown =>
  new Proxy(Promise.resolve<never[]>([]), {
    get: (rows, key) =>
      key === "then" ? rows.then.bind(rows) : (): unknown => noRows(),
  });

/**
 * The file deletion fence for hermetic suites, which have no shared database
 * pool. Legal-hold refusals are covered by the Postgres suites, which keep
 * the root pool.
 */
export const holdFreeFileDeletionDb: OrganizationFileDeletionDb = {
  transaction: async <T>(callback: (tx: Transaction) => Promise<T>) =>
    await callback(
      asTestRaw<Transaction>({
        execute: noRows,
        select: noRows,
        selectDistinct: noRows,
      }),
    ),
};
