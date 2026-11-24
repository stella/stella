import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import {
  claimCorpusProjectionCleanupTx,
  corpusProjectionCleanupDecisionQuery,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { corpusProjectionMigrationDdl } from "@/api/tests/helpers/corpus-projection-migration-ddl";
import { optOutOfCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Queued copies a state still names after the desired state moved more than
 * one change past them: the cleanup claim keeps one serving unless an erasure
 * since its reservation is recorded. The database guard admits exactly the
 * restores the claim makes. The family is case law; legislation is checked to
 * be claimed as before.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const caseLaw = corpusProjectionLegacyFixture(() => db, "case_law");
const legislation = corpusProjectionLegacyFixture(() => db, "legislation");
const {
  uuid,
  fingerprint,
  installProjectionDdl,
  run,
  servedEntity,
  changeDesired,
  thisReleaseChanges,
  previousPrepare,
  previousClaim,
  previousSweepCleanup,
  previousErasureFence,
  previousRepair,
  recordWithdrawal,
  subjectOf,
  claim,
  intentOf,
  stateOf,
} = caseLaw;

type Served = { entityId: string; revision: string };

beforeEach(async () => {
  client = await createTestPglite();
  await optOutOfCorpusProjectionSeedingGuard(client, {
    reason:
      "Stands canonical rows, desired states and an earlier release's queued copies up as direct fixture writes the seeding rule does not hold for (`changeDesired`, `previousPrepare`, the canonical updates). Several tests then move desired state through this release's writer (`advanceCorpusProjectionDesiredStateTx`, directly or through the fixture's `thisReleaseChanges`) on top of those fixtures, so the guard would judge the fixtures, not the writer; the writer suites keep the guard.",
  });
  db = drizzle({ client });
  await caseLaw.seedGeneration();
  await legislation.seedGeneration();
});

afterEach(async () => {
  await client.close();
});

/** The copy is queued one change behind, then a second change goes by. */
const queueThenDrift = async (
  { entityId, revision }: Served,
  between: (entityId: string) => Promise<void> = async () => undefined,
) => {
  await changeDesired(entityId, 2, {
    action: "upsert",
    fingerprint: fingerprint(1),
  });
  await previousPrepare(entityId, revision);
  await between(entityId);
  await changeDesired(entityId, 3, {
    action: "upsert",
    fingerprint: fingerprint(2),
  });
};

/** An erasure and its undo, then the earlier release's preparation. */
const eraseUndoThenQueue = async ({ entityId, revision }: Served) => {
  await changeDesired(entityId, 2, { action: "erase" });
  await changeDesired(entityId, 3, {
    action: "upsert",
    fingerprint: fingerprint(1),
  });
  await previousPrepare(entityId, revision);
};

const revisionId = (revision: string) =>
  toSafeId<"corpusIndexProjectionIntent">(revision);

const expectKept = async ({ entityId, revision }: Served) => {
  const result = await claim();
  expect(result).toEqual({
    leases: [],
    claimed: { unserved: 0, served_after_delete: 0, served_unproven: 0 },
    restoredIntentIds: [revisionId(revision)],
    skippedLocked: 0,
  });
  expect(await intentOf(revision)).toEqual({
    status: "applied",
    cleanupAttempts: 0,
    cleanupNotBefore: null,
    lastError: null,
  });
  expect(await stateOf(entityId)).toEqual({
    desiredAction: "upsert",
    appliedAction: "upsert",
    appliedRevision: revisionId(revision),
  });
  // It left the queue: the next turn does not read it again.
  expect(await claim()).toMatchObject({
    leases: [],
    restoredIntentIds: [],
    skippedLocked: 0,
  });
};

const expectClaimedUnproven = async ({ revision }: Served) => {
  const result = await claim();
  expect(result).toMatchObject({
    claimed: { unserved: 0, served_after_delete: 0, served_unproven: 1 },
    restoredIntentIds: [],
    skippedLocked: 0,
  });
  expect(result.leases.map(({ intentId }) => intentId)).toEqual([
    revisionId(revision),
  ]);
  expect(await intentOf(revision)).toMatchObject({
    status: "cleanup_started",
    cleanupAttempts: 1,
  });
};

const recordJob = async (
  entityId: string,
  operation: string,
  status: "succeeded" | "failed",
) => {
  await run(sql`
    INSERT INTO case_law_index_jobs (
      id, decision_id, operation, status, error_message
    ) VALUES (
      ${uuid()}, ${entityId}, ${operation}, ${status},
      ${status === "failed" ? "the operation failed" : null}
    )
  `);
};

/** The canonical row of a redaction. */
const redactRow = async (entityId: string) => {
  await run(sql`
    UPDATE case_law_decisions
    SET redacted_at = clock_timestamp(), content_hash = NULL
    WHERE id = ${entityId}
  `);
};

/** A change of the decision that records no erasure. */
const replaceText = async (entityId: string) => {
  await run(sql`
    UPDATE case_law_decisions
    SET content_hash = ${fingerprint(3)}, updated_at = clock_timestamp()
    WHERE id = ${entityId}
  `);
};

const RESTORE_REFUSAL =
  "only a queued copy its upsert state keeps serving can be restored";

/** Every message of a failed statement, down its chain of causes. */
const messagesOf = (error: unknown): string =>
  error instanceof Error ? `${error.message}\n${messagesOf(error.cause)}` : "";

/**
 * The restore as any writer would issue it, rolled back when admitted: true
 * when the guard admits it (the update returned the revision), false when the
 * restore guard refuses it. Any other failure is rethrown, so a refusal is
 * never a missing row or an unrelated error.
 */
const guardAdmitsRestore = async (revision: string): Promise<boolean> => {
  const attempted = await Result.tryPromise(
    async () =>
      await db.transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE corpus_index_projection_intents
          SET status = 'applied', cleanup_not_before = NULL,
              lease_token = NULL, lease_expires_at = NULL
          WHERE id = ${revision}
          RETURNING id::text AS id
        `);
        expect(updated.rows).toEqual([{ id: revision }]);
        tx.rollback();
      }),
  );
  if (attempted.isOk()) {
    return panic("An admitted restore must roll back");
  }
  if (attempted.error.cause instanceof TransactionRollbackError) {
    return true;
  }
  if (messagesOf(attempted.error).includes(RESTORE_REFUSAL)) {
    return false;
  }
  return panic("The restore failed for another reason", attempted.error);
};

describe("the claim's decision about a drifted copy a state still names", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  test("keeps it serving when no erasure is recorded", async () => {
    const served = await servedEntity();
    await queueThenDrift(served);
    await expectKept(served);
  });

  test("restores a copy one change behind whose desired index moved: it serves until the append to the new index applies", async () => {
    const served = await servedEntity();
    await changeDesired(served.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await run(sql`
      UPDATE corpus_index_projection_states
      SET desired_index_id = 'case_law_v5_other'
      WHERE entity_id = ${served.entityId}
    `);
    await previousPrepare(served.entityId, served.revision);
    expect(await guardAdmitsRestore(served.revision)).toBe(true);
    await expectKept(served);
  });

  test("keeps it serving when its desired value changed twice before it was queued", async () => {
    const served = await servedEntity();
    await changeDesired(served.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });
    await previousPrepare(served.entityId, served.revision);
    await expectKept(served);
  });

  test("keeps it serving through desired changes that record no erasure", async () => {
    const served = await servedEntity();
    await eraseUndoThenQueue(served);
    await expectKept(served);
  });

  test("claims it when a withdrawal and its undo came before it was queued", async () => {
    const served = await servedEntity();
    await recordWithdrawal(served.entityId);
    await eraseUndoThenQueue(served);
    await expectClaimedUnproven(served);
  });

  test("claims it when a withdrawal and its undo came after it was queued", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async (entityId) => {
      await recordWithdrawal(entityId);
    });
    await expectClaimedUnproven(served);
  });

  test("keeps it serving when the withdrawal was recorded before it was reserved", async () => {
    const served = await servedEntity({ beforeReservation: recordWithdrawal });
    await queueThenDrift(served);
    await expectKept(served);
  });

  test("keeps it serving through trail rows that are no succeeded withdrawal", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async (entityId) => {
      await recordJob(entityId, "index", "succeeded");
      await recordJob(entityId, "delete", "succeeded");
      await recordJob(entityId, "withdraw", "failed");
    });
    await expectKept(served);
  });

  test("keeps it serving through another decision's withdrawal", async () => {
    const other = await servedEntity();
    const served = await servedEntity();
    await queueThenDrift(served, async () => {
      await recordWithdrawal(other.entityId);
    });
    await expectKept(served);
  });

  test.each(["succeeded", "failed"] as const)(
    "claims it when a redaction was ever recorded as %s",
    async (status) => {
      const served = await servedEntity({
        beforeReservation: async (entityId) =>
          await recordJob(entityId, "redact", status),
      });
      await queueThenDrift(served);
      await expectClaimedUnproven(served);
    },
  );

  test("claims it when the decision is redacted", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async (entityId) => {
      await redactRow(entityId);
    });
    await expectClaimedUnproven(served);
  });

  test("claims it when the decision no longer exists", async () => {
    const served = await servedEntity();
    await recordWithdrawal(served.entityId);
    await queueThenDrift(served);
    await run(sql`
      DELETE FROM case_law_decisions WHERE id = ${served.entityId}
    `);
    const trail = await db.execute(sql`
      SELECT 1 FROM case_law_index_jobs WHERE decision_id = ${served.entityId}
    `);
    expect(trail.rows).toEqual([]);
    await expectClaimedUnproven(served);
  });

  test("keeps it serving through a change that records no erasure", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, replaceText);
    await expectKept(served);
  });

  test("keeps it serving while its document is pending", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async (entityId) => {
      await run(sql`
        UPDATE case_law_decisions
        SET content_hash = NULL, corpus_mirror_status = 'pending'
        WHERE id = ${entityId}
      `);
    });
    await expectKept(served);
  });

  test("claims it when the decision settled without a document", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async (entityId) => {
      await run(sql`
        UPDATE case_law_decisions SET content_hash = NULL WHERE id = ${entityId}
      `);
    });
    await expectClaimedUnproven(served);
  });

  test("keeps it serving through further projection writes", async () => {
    const served = await servedEntity();
    await queueThenDrift(served);
    // This release's desired writer moves the canonical epoch twice more.
    for (let turn = 0; turn < 2; turn += 1) {
      // db-await-in-loop: one desired change after another
      await db.transaction(
        async (tx) =>
          await advanceCorpusProjectionDesiredStateTx(
            asTestRaw<Transaction>(tx),
            subjectOf(served.entityId),
          ),
      );
    }
    await expectKept(served);
  });

  test("claims it when the desired index moved", async () => {
    const served = await servedEntity();
    await queueThenDrift(served);
    await run(sql`
      UPDATE case_law_decisions SET projection_epoch = 4
      WHERE id = ${served.entityId}
    `);
    await run(sql`
      UPDATE corpus_index_projection_states
      SET desired_epoch = 4, desired_index_id = 'case_law_v5_other'
      WHERE entity_id = ${served.entityId}
    `);
    await expectClaimedUnproven(served);
  });

  test("claims a legislation copy", async () => {
    const served = await legislation.servedEntity();
    await legislation.changeDesired(served.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await legislation.previousPrepare(served.entityId, served.revision);
    await legislation.changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });
    const result = await legislation.claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.served_unproven).toBe(1);
  });
});

describe("dispositions the erasure records do not change", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  test("a copy whose state desires an erasure is ordinary cleanup", async () => {
    const served = await servedEntity();
    await changeDesired(served.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(served.entityId, served.revision);
    await changeDesired(served.entityId, 3, { action: "erase" });
    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed).toEqual({
      unserved: 1,
      served_after_delete: 0,
      served_unproven: 0,
    });
  });

  test("a copy a delete may have reached is claimed again", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async () => {
      await previousClaim(served.revision);
      await previousSweepCleanup(served.revision);
      // Attempts alone decide, with no recorded reason left.
      await run(sql`
        UPDATE corpus_index_projection_intents SET last_error = NULL
        WHERE id = ${served.revision}
      `);
    });
    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 1,
      served_unproven: 0,
    });
    expect(await intentOf(served.revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 2,
    });
  });

  test("a copy the projection rows alone prove is restored whatever is recorded", async () => {
    const oneChange = await servedEntity();
    await recordWithdrawal(oneChange.entityId);
    await changeDesired(oneChange.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(oneChange.entityId, oneChange.revision);
    await expectKept(oneChange);

    const sameContent = await servedEntity();
    await recordWithdrawal(sameContent.entityId);
    await changeDesired(sameContent.entityId, 2, { action: "erase" });
    await changeDesired(sameContent.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(0),
    });
    await previousPrepare(sameContent.entityId, sameContent.revision);
    await expectKept(sameContent);
  });

  test("a copy an erasure queued is claimed", async () => {
    const served = await servedEntity();
    await changeDesired(served.entityId, 2, { action: "erase" });
    await previousErasureFence(served.revision);
    await changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await expectClaimedUnproven(served);
  });

  test("a copy a drift repair queued is claimed", async () => {
    const served = await servedEntity();
    await previousRepair(served.entityId, served.revision);
    await changeDesired(served.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });
    await expectClaimedUnproven(served);
  });

  test("a copy queued with any other recorded reason is claimed", async () => {
    const served = await servedEntity();
    await queueThenDrift(served, async () => {
      await run(sql`
        UPDATE corpus_index_projection_intents
        SET last_error = 'projection append lease expired with unknown outcome'
        WHERE id = ${served.revision}
      `);
    });
    await expectClaimedUnproven(served);
  });
});

describe("a copy the claim kept", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  test("serves through the next canonical change and is un-named by an undone erasure", async () => {
    const served = await servedEntity();
    await queueThenDrift(served);
    await expectKept(served);

    await thisReleaseChanges(served.entityId, fingerprint(3));
    expect(await stateOf(served.entityId)).toMatchObject({
      appliedRevision: revisionId(served.revision),
    });

    await recordWithdrawal(served.entityId);
    await run(sql`
      UPDATE case_law_decisions SET content_hash = NULL
      WHERE id = ${served.entityId}
    `);
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          subjectOf(served.entityId),
        ),
    );
    expect(await stateOf(served.entityId)).toMatchObject({
      desiredAction: "erase",
    });
    await thisReleaseChanges(served.entityId, fingerprint(4));
    expect(await stateOf(served.entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.unserved).toBe(1);
  });

  test("does not hold back the cleanup behind it: every turn's rows leave the queue", async () => {
    const LIMIT = 2;
    const kept: Served[] = [];
    for (let index = 0; index < 2 * LIMIT; index += 1) {
      // db-await-in-loop: rows are seeded in queue order
      const served = await servedEntity();
      // db-await-in-loop: rows are seeded in queue order
      await queueThenDrift(served);
      kept.push(served);
    }
    const behind = await servedEntity();
    await recordWithdrawal(behind.entityId);
    await eraseUndoThenQueue(behind);

    const turn = async () =>
      await db.transaction(
        async (tx) =>
          await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
            family: caseLaw.family,
            generation: caseLaw.generation,
            indexId: caseLaw.indexId,
            limit: LIMIT,
            leaseMs: 60_000,
          }),
      );
    const first = await turn();
    const second = await turn();
    expect(
      [...first.restoredIntentIds, ...second.restoredIntentIds].toSorted(),
    ).toEqual(kept.map(({ revision }) => revisionId(revision)).toSorted());
    expect(first.leases).toEqual([]);
    expect(second.leases).toEqual([]);
    const third = await turn();
    expect(third.restoredIntentIds).toEqual([]);
    expect(third.leases.map(({ intentId }) => intentId)).toEqual([
      revisionId(behind.revision),
    ]);
  });
});

describe("the restore guard", () => {
  const RESTORE_MIGRATION =
    "20261124143000_corpus_projection_superseded_copy_restore";

  const installBefore = async (before: string) => {
    for (const ddl of await corpusProjectionMigrationDdl({ before })) {
      // db-await-in-loop: DDL applies in migration order
      await db.execute(sql.raw(ddl));
    }
  };

  const applyMigration = async (name: string) => {
    const text = await Bun.file(
      new URL(`../../../drizzle/${name}/migration.sql`, import.meta.url),
    ).text();
    const functions = text
      .split("--> statement-breakpoint")
      .filter((part) => /CREATE (?:OR REPLACE )?FUNCTION/u.test(part));
    expect(functions.length).toBeGreaterThan(0);
    for (const statement of functions) {
      // db-await-in-loop: DDL applies in order
      await db.execute(sql.raw(statement));
    }
  };

  test("the migration admits the restore of a drifted copy with no recorded erasure, and only that", async () => {
    await installBefore(RESTORE_MIGRATION);
    const kept = await servedEntity();
    await queueThenDrift(kept);
    const withdrawn = await servedEntity();
    await queueThenDrift(withdrawn, recordWithdrawal);
    const oneChange = await servedEntity();
    await changeDesired(oneChange.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(oneChange.entityId, oneChange.revision);
    const restores = async () => ({
      kept: await guardAdmitsRestore(kept.revision),
      withdrawn: await guardAdmitsRestore(withdrawn.revision),
      oneChange: await guardAdmitsRestore(oneChange.revision),
    });
    expect(await restores()).toEqual({
      kept: false,
      withdrawn: false,
      oneChange: true,
    });

    await applyMigration(RESTORE_MIGRATION);
    expect(await restores()).toEqual({
      kept: true,
      withdrawn: false,
      oneChange: true,
    });
  });

  test("corpus-projection.superseded-restore-guard-matches-claim", async () => {
    await installProjectionDdl(true);
    await assertProperty(
      "corpus-projection.superseded-restore-guard-matches-claim",
      fc.asyncProperty(
        fc.record({
          withdrawal: fc.constantFrom(
            "none" as const,
            "before_reservation" as const,
            "failed" as const,
            "since_reservation" as const,
          ),
          redaction: fc.constantFrom(
            "none" as const,
            "trail" as const,
            "row" as const,
          ),
          document: fc.constantFrom(
            "stored" as const,
            "replaced" as const,
            "replacement_pending" as const,
            "settled_without" as const,
          ),
          claimedBefore: fc.boolean(),
          lastError: fc.boolean(),
          changes: fc.constantFrom(1 as const, 2 as const),
          desired: fc.constantFrom(
            "other_content" as const,
            "same_content" as const,
            "other_index" as const,
            "erase" as const,
          ),
        }),
        async ({
          withdrawal,
          redaction,
          document,
          claimedBefore,
          lastError,
          changes,
          desired,
        }) => {
          const served = await servedEntity({
            beforeReservation: async (entityId) => {
              if (withdrawal === "before_reservation") {
                await recordWithdrawal(entityId);
              }
            },
          });
          const { entityId, revision } = served;
          await changeDesired(entityId, 2, {
            action: "upsert",
            fingerprint:
              desired === "same_content" ? fingerprint(0) : fingerprint(1),
          });
          await previousPrepare(entityId, revision);
          if (withdrawal === "since_reservation") {
            await recordWithdrawal(entityId);
          }
          if (document === "replaced") {
            await replaceText(entityId);
          }
          if (document === "replacement_pending") {
            await run(sql`
              UPDATE case_law_decisions
              SET content_hash = NULL, corpus_mirror_status = 'pending'
              WHERE id = ${entityId}
            `);
          }
          if (document === "settled_without") {
            await run(sql`
              UPDATE case_law_decisions SET content_hash = NULL
              WHERE id = ${entityId}
            `);
          }
          if (withdrawal === "failed") {
            await recordJob(entityId, "withdraw", "failed");
          }
          if (redaction === "trail") {
            await recordJob(entityId, "redact", "failed");
          }
          if (redaction === "row") {
            await redactRow(entityId);
          }
          if (claimedBefore) {
            await previousClaim(revision);
            await previousSweepCleanup(revision);
          }
          await run(sql`
            UPDATE corpus_index_projection_intents
            SET last_error = ${lastError ? "projection revision scheduled by erasure" : null}
            WHERE id = ${revision}
          `);
          if (changes === 2) {
            await changeDesired(
              entityId,
              3,
              desired === "erase"
                ? { action: "erase" }
                : {
                    action: "upsert",
                    fingerprint:
                      desired === "same_content"
                        ? fingerprint(0)
                        : fingerprint(2),
                  },
            );
          }
          if (changes === 2 && desired === "other_index") {
            await run(sql`
              UPDATE case_law_decisions SET projection_epoch = 4
              WHERE id = ${entityId}
            `);
            await run(sql`
              UPDATE corpus_index_projection_states
              SET desired_epoch = 4, desired_index_id = 'case_law_v5_other'
              WHERE entity_id = ${entityId}
            `);
          }

          const decision =
            (
              await db.transaction(
                async (tx) =>
                  await corpusProjectionCleanupDecisionQuery(
                    asTestRaw<Transaction>(tx),
                    {
                      family: caseLaw.family,
                      intentIds: [revisionId(revision)],
                    },
                  ),
              )
            ).at(0)?.disposition ?? panic("No decision");
          const restores =
            decision === "restorable" || decision === "kept_superseded";
          expect({ admitted: await guardAdmitsRestore(revision) }).toEqual({
            admitted: restores,
          });

          const oneChange = changes === 1;
          const erased = changes === 2 && desired === "erase";
          const sameContent = desired === "same_content";
          const recorded =
            withdrawal === "since_reservation" ||
            redaction !== "none" ||
            document === "settled_without";
          const untouched = !claimedBefore && !lastError && !erased;
          expect(decision).toBe(
            (() => {
              if (erased) {
                return "unserved";
              }
              if (untouched && (oneChange || sameContent)) {
                return "restorable";
              }
              if (claimedBefore) {
                return "served_after_delete";
              }
              return untouched && !recorded && desired !== "other_index"
                ? "kept_superseded"
                : "served_unproven";
            })(),
          );
        },
      ),
      { numRuns: 64 },
    );
  });
});
