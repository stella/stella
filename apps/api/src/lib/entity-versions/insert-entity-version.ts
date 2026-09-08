import { panic } from "better-result";
import { isNotNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entityVersions } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { generateVerificationCode } from "@/api/lib/document-reference";

/**
 * What a writer supplies for a version row. `verificationCode` is absent by
 * construction: this module is the only place that mints one, so no caller can
 * hold a copy of a code the database may not have accepted.
 */
type EntityVersionValues = Omit<
  typeof entityVersions.$inferInsert,
  "verificationCode"
>;

type PendingEntityVersion = typeof entityVersions.$inferInsert;

/**
 * Fresh codes to try before declaring the generator broken. A code is one of
 * 31^10 (~8.2e14) values, so a row that loses this many independent draws is
 * not unlucky: something upstream stopped producing random codes, and looping
 * on it would hide that behind a hung transaction.
 */
const MAX_CODE_ATTEMPTS = 4;

/**
 * A stamp and its verification code are one artifact: the download stamper
 * (`handlers/files/get.ts`) and the `/v/<code>` lookup both need the pair, so
 * a row carries both or neither. Deriving the code from the stamp keeps that
 * pairing true at every writer instead of at thirteen of them.
 */
const withVerificationCode = (
  values: EntityVersionValues,
): PendingEntityVersion => ({
  ...values,
  // The column's `$defaultFn` would mint this per statement, so a retried row
  // would arrive under a new id. Mint it once here: RETURNING is matched back
  // to the rows by id, and callers already reference the version they wrote.
  id: values.id ?? createSafeId<"entityVersion">(),
  verificationCode:
    values.stamp === null || values.stamp === undefined
      ? null
      : generateVerificationCode(),
});

/**
 * Insert entity-version rows, self-healing a verification-code collision.
 *
 * `entity_versions_vcode_uidx` is the only arbiter the statement names, so a
 * duplicate code costs the row a skip rather than an aborted transaction (no
 * savepoint needed, and no extra round trip on the path that never collides).
 * Every other unique violation - a replayed id, a duplicate
 * (entity_id, version_number) - is a different bug with different replay
 * semantics and still raises, exactly as before.
 *
 * A skipped row is therefore a code collision and nothing else: the retry
 * re-inserts only the missing rows with fresh codes. The code the caller never
 * saw is the code that is stored; readers take it from the row.
 */
export const insertEntityVersions = async (
  tx: Transaction,
  values: EntityVersionValues[],
): Promise<void> => {
  if (values.length === 0) {
    return;
  }

  let pending = values.map(withVerificationCode);

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded code-collision retry: each attempt inserts exactly the rows the previous attempt reported as skipped
    const inserted = await tx
      .insert(entityVersions)
      .values(pending)
      .onConflictDoNothing({
        target: entityVersions.verificationCode,
        // Matches the index predicate so Postgres can infer the partial index.
        where: isNotNull(entityVersions.verificationCode),
      })
      .returning({ id: entityVersions.id });

    const storedIds = new Set(inserted.map(({ id }) => id));
    const collided = pending.filter(({ id }) => !storedIds.has(id));
    if (collided.length === 0) {
      return;
    }

    pending = collided.map(withVerificationCode);
  }

  panic(
    `Verification code collided on ${String(MAX_CODE_ATTEMPTS)} independent draws`,
  );
};

/** Single-row form of {@link insertEntityVersions}. */
export const insertEntityVersion = async (
  tx: Transaction,
  values: EntityVersionValues,
): Promise<void> => await insertEntityVersions(tx, [values]);
