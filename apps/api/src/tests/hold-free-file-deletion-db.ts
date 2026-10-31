import type { Transaction } from "@/api/db/root";
import type { OrganizationFileDeletionDb } from "@/api/lib/files/organization-file-deletion-db";

import { asTestRaw } from "./helpers/test-tool-set";

type NoRows = ((...args: unknown[]) => NoRows) & {
  then: (resolve: (rows: never[]) => unknown) => Promise<unknown>;
};

// Every query the fence builds resolves to no rows, whatever its chain:
// no requested key belongs to an organization, so no legal hold applies.
const noRows = (): NoRows =>
  new Proxy(() => noRows(), {
    get: (_target, key) =>
      key === "then"
        ? async (resolve: (rows: never[]) => unknown) =>
            await Promise.resolve(resolve([]))
        : () => noRows(),
  }) as NoRows;

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
