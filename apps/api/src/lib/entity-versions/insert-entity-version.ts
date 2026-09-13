import { panic } from "better-result";
import { and, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entityVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { recordEntityStamp } from "@/api/lib/document-counter";
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

/**
 * Fresh codes to try before declaring the generator broken. A code is one of
 * 31^10 (~8.2e14) values, so a row that loses this many independent draws is
 * not unlucky: something upstream stopped producing random codes, and looping
 * on it would hide that behind a hung transaction.
 */
const MAX_CODE_ATTEMPTS = 4;

/**
 * A stamp and its verification code are one artifact: the download stamper
 * (`handlers/files/get.ts`) and the `/verify/<code>` page both need the pair, so
 * a row carries both or neither. Deriving the code from the stamp keeps that
 * pairing true at every writer instead of at thirteen of them.
 */
const withVerificationCode = (values: EntityVersionValues) => ({
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

  for (const value of values) {
    if (value.stamp === null || value.stamp === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one transaction connection must serialize ledger row locks
    await recordEntityStamp({
      tx,
      workspaceId: value.workspaceId,
      stamp: value.stamp,
    });
  }

  await insertPendingEntityVersions(tx, values.map(withVerificationCode), 1);
};

const insertPendingEntityVersions = async (
  tx: Transaction,
  pending: ReturnType<typeof withVerificationCode>[],
  attempt: number,
): Promise<void> => {
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

  if (attempt === MAX_CODE_ATTEMPTS) {
    panic(
      `Verification code collided on ${String(MAX_CODE_ATTEMPTS)} independent draws`,
    );
  }

  await insertPendingEntityVersions(
    tx,
    collided.map(withVerificationCode),
    attempt + 1,
  );
};

/** Single-row form of {@link insertEntityVersions}. */
export const insertEntityVersion = async (
  tx: Transaction,
  values: EntityVersionValues,
): Promise<void> => await insertEntityVersions(tx, [values]);

/** One source version and the row that replaces it. */
type VerificationCodeTransfer = {
  sourceVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
};

/**
 * Move each source version's verification code onto the row that replaces it.
 *
 * A code printed into a downloaded DOCX must keep resolving for the life of
 * the document, so re-homing a document across matters re-homes its codes with
 * it instead of retiring them. `entity_versions_vcode_uidx` is global, so a
 * code lives on exactly one row: the sources are cleared first, then the
 * targets take what they carried. The caller deletes the source rows later in
 * this same transaction, which is the only reason clearing them is a write and
 * not a loss.
 *
 * Codes stay owned by this module — a caller names the two rows, never a code.
 * A source with no stamp carries no code and is simply not among the rows read.
 */
export const carryVerificationCodes = async (
  tx: Transaction,
  transfers: readonly VerificationCodeTransfer[],
): Promise<void> => {
  if (transfers.length === 0) {
    return;
  }

  // FOR UPDATE holds the source rows for the rest of the transaction, so no
  // concurrent writer can replace a code between this read and the clear. A
  // tombstoned version resolves to nothing by design, so its code is left
  // where it is rather than given a live row to resolve to.
  const sourceRows = await tx
    .select({
      id: entityVersions.id,
      verificationCode: entityVersions.verificationCode,
    })
    .from(entityVersions)
    .where(
      and(
        inArray(
          entityVersions.id,
          transfers.map(({ sourceVersionId }) => sourceVersionId),
        ),
        isNotNull(entityVersions.verificationCode),
        isNull(entityVersions.deletedAt),
      ),
    )
    .for("update");

  const codeBySourceId = new Map(
    sourceRows.map(({ id, verificationCode }) => [id, verificationCode]),
  );
  const carried = transfers.flatMap(({ sourceVersionId, targetVersionId }) => {
    const code = codeBySourceId.get(sourceVersionId);
    return code ? [sql`(${targetVersionId}::uuid, ${code}::varchar)`] : [];
  });
  if (carried.length === 0) {
    return;
  }

  // The same predicate the codes were read under, so the clear is the exact
  // set that was locked: live rows, keyed by id.
  await tx
    .update(entityVersions)
    .set({ verificationCode: null })
    .where(
      and(
        inArray(entityVersions.id, [...codeBySourceId.keys()]),
        isNull(entityVersions.deletedAt),
      ),
    );

  await tx.execute(sql`
    UPDATE ${entityVersions} AS target
       SET verification_code = carried.verification_code
      FROM (VALUES ${sql.join(carried, sql`, `)})
           AS carried(target_id, verification_code)
     WHERE target.id = carried.target_id`);
};
