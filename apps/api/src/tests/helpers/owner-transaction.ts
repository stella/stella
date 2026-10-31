import type { Transaction } from "@/api/db/root";
import type { OwnerTransaction } from "@/api/lib/db/aggregate-lock";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * A test transaction standing in for one on the owner connection, so a
 * double can reach owner-held locks. Production code gets an owner
 * transaction only from `withOwnerTransaction` on the owner database.
 */
export const asOwnerTransaction = (tx: object): OwnerTransaction<Transaction> =>
  asTestRaw<OwnerTransaction<Transaction>>(tx);
