import type { Transaction } from "@/api/db/root";
import { ownerTransactionDouble } from "@/api/lib/db/aggregate-lock";
import type { OwnerTransaction } from "@/api/lib/db/aggregate-lock";
import { createOwnerDatabase } from "@/api/lib/db/owner-transaction";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * A test transaction standing in for one on the owner connection, so a
 * double can reach owner-held locks. Production code gets an owner
 * transaction only from `withOwnerAggregateTransaction` on a registered
 * owner connection.
 */
export const asOwnerTransaction = (
  tx: object,
): OwnerTransaction<Transaction> => {
  ownerTransactionDouble(tx);
  return asTestRaw<OwnerTransaction<Transaction>>(tx);
};

/**
 * A test database registered as an owner connection. Registration records
 * the object's identity and never changes the object, so a shared test
 * database stays as it was for every other caller.
 */
export const ownerDatabaseDouble = <Database extends object>(
  database: Database,
) => createOwnerDatabase(() => database);
