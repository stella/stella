/**
 * Code-owned online repair: an erased account row holds no delivery-failure
 * record.
 *
 * `anonymizeDeletedAccountRow` clears the refused address, its reason and its
 * time together with the rest of the row's private fields. Rows erased before
 * it did may still hold them; this repair clears those on every deploy until
 * none is left, and a later deploy finds nothing to do.
 *
 * The account table is small and the statement touches only erased rows, so
 * one transaction under its own LOCAL budgets suffices; it takes no table lock
 * to gate and never defers.
 */

import type {
  CodeOwnedOnlineStep,
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const REPAIR_NAME = "deleted-account-delivery-failures";
const LOCK_TIMEOUT = "10s";
const STATEMENT_TIMEOUT = "2min";

const ERASED_ROW_WITH_DELIVERY_FAILURE = `deleted_at IS NOT NULL
  AND (email_undeliverable_address IS NOT NULL
    OR email_undeliverable_reason IS NOT NULL
    OR email_undeliverable_at IS NOT NULL)`;

const READ_REMAINING_SQL = `
  SELECT 1
  FROM public."user"
  WHERE ${ERASED_ROW_WITH_DELIVERY_FAILURE}
  LIMIT 1
`;

const CLEAR_SQL = `
  UPDATE public."user"
  SET email_undeliverable_address = NULL,
    email_undeliverable_reason = NULL,
    email_undeliverable_at = NULL
  WHERE ${ERASED_ROW_WITH_DELIVERY_FAILURE}
`;

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> =>
  (await connection.query(READ_REMAINING_SQL)).length === 0
    ? { type: "complete" }
    : {
        reason: "an erased account still holds a delivery-failure record",
        type: "incomplete",
      };

const repair = async (connection: OnlineMigrationConnection): Promise<void> => {
  await connection.execute("BEGIN");
  // A failure is rolled back so the session stays usable for the lock
  // release, then rethrown to fail the migrate task.
  try {
    await connection.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await connection.execute(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
    );
    await connection.execute(CLEAR_SQL);
    await connection.execute("COMMIT");
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

export const DELETED_ACCOUNT_ROW_REPAIR = {
  introducedBy: {
    type: "code",
    owner: "src/db/deleted-account-row-repair.ts",
  },
  name: REPAIR_NAME,
  readCompletion,
  repair: async (connection: OnlineMigrationConnection) => {
    await repair(connection);
    return { type: "complete" } as const;
  },
} satisfies OnlineRepair & { introducedBy: CodeOwnedOnlineStep };
