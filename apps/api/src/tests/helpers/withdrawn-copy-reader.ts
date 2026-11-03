import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { asTestRaw } from "./test-tool-set";

export const createTestCaseLawReader = (database: () => TestDatabase) =>
  asTestRaw<CaseLawPublicReadDb>(
    async <T>(
      read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ): Promise<T> => await read(asTestRaw(database())),
  );

export const createTestWithdrawalCopyReader = (
  database: () => TestDatabase,
) => {
  const reader = createTestCaseLawReader(database);
  return async (options: Parameters<typeof readWithdrawnCopyProjection>[0]) =>
    await readWithdrawnCopyProjection({ ...options, caseLawDb: reader });
};
