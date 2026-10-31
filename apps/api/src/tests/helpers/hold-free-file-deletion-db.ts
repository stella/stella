import type { Transaction } from "@/api/db/root";
import type { OrganizationFileDeletionDb } from "@/api/lib/files/delete-organization-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createSelectQueryMock } from "@/api/tests/scoped-db-mock";

/**
 * Owner database for file deletion in suites without Postgres: no requested
 * key resolves to an organization, so no legal hold applies and the deletion
 * reaches storage. Suites that exercise holds use a real database.
 */
export const holdFreeFileDeletionDb: OrganizationFileDeletionDb = {
  transaction: async <T>(callback: (tx: Transaction) => Promise<T>) =>
    await callback(
      asTestRaw<Transaction>({
        select: () => createSelectQueryMock([]),
        selectDistinct: () => createSelectQueryMock([]),
      }),
    ),
};
