import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { corpusIndexProjectionStates } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusProjectionDesiredStateTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  type LegacyServedCopyRetireCursor,
  LegacyServedCopyRetireCutoverMismatchError,
  retireLegacyUnprovenServedCopiesTx,
} from "@/api/lib/legal-search/corpus-index-projection-legacy-retire";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The one-off pass over served copies an earlier release left two or more
 * desired changes behind, against the production guards installed from the
 * migrations, with that release's writes replayed in its statement shapes and
 * this release's writes made through its own desired writer. Case law is the
 * family that records withdrawals; legislation is checked to be kept.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const caseLaw = corpusProjectionLegacyFixture(() => db, "case_law");
const legislation = corpusProjectionLegacyFixture(() => db, "legislation");
const {
  fingerprint,
  installProjectionDdl,
  run,
  servedEntity,
  changeDesired,
  thisReleaseChanges,
  namesFreshCopy,
  previousPrepare,
  recordWithdrawal,
  subjectOf,
  claim,
  intentOf,
  stateOf,
} = caseLaw;

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await caseLaw.seedGeneration();
  await legislation.seedGeneration();
});

afterEach(async () => {
  await client.close();
});

describe("the one-off pass over copies the previous release left served", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  /**
   * A served copy the previous release kept through a recorded withdrawal and
   * its undo.
   */
  const erasedThenUndone = async (finalFingerprint: string) => {
    const served = await servedEntity();
    await recordWithdrawal(served.entityId);
    await changeDesired(served.entityId, 2, { action: "erase" });
    await changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: finalFingerprint,
    });
    return served;
  };

  /** This release's reconciliation of one entity with its canonical row. */
  const thisReleaseReconciles = async (entityId: string) => {
    await db.transaction(
      async (tx) =>
        await reconcileCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          subjectOf(entityId),
        ),
    );
  };

  /**
   * This release's re-projection of an unchanged canonical row: every
   * generation moves to a newer epoch with the same content, as a
   * ranking-signal drain does.
   */
  const thisReleaseReprojects = async (entityId: string) => {
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          subjectOf(entityId),
        ),
    );
  };

  const cutoverAt = async () => {
    await db.execute(sql`SELECT pg_sleep(0.002)`);
    const now = (
      await db.execute<{ now: string }>(
        sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
      )
    ).rows.at(0)?.now;
    return Temporal.Instant.from(now ?? panic("No clock"));
  };

  const passResult = async (
    instant: Temporal.Instant,
    after: LegacyServedCopyRetireCursor | null,
    limit: number,
    mode: "retire" | "count" = "retire",
    fixture: typeof caseLaw = caseLaw,
  ) =>
    await db.transaction(
      async (tx) =>
        await retireLegacyUnprovenServedCopiesTx(asTestRaw<Transaction>(tx), {
          family: fixture.family,
          generation: fixture.generation,
          cutoverAt: instant,
          after,
          limit,
          mode,
        }),
    );

  const pass = async (
    instant: Temporal.Instant,
    after: LegacyServedCopyRetireCursor | null,
    limit: number,
    mode: "retire" | "count" = "retire",
    fixture: typeof caseLaw = caseLaw,
  ) => (await passResult(instant, after, limit, mode, fixture)).unwrap();

  const desiredAtOf = async (entityId: string) =>
    (
      await db
        .select({ desiredAt: corpusIndexProjectionStates.desiredAt })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, entityId))
    ).at(0)?.desiredAt ?? panic("No desired instant");

  /** Whether the state still serves its copy, and the copy is still applied. */
  const stillServed = async ({
    entityId,
    revision,
  }: {
    entityId: string;
    revision: string;
  }) => {
    expect(await stateOf(entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
  };

  test("retires a copy with other content and keeps one holding the desired content", async () => {
    const other = await erasedThenUndone(fingerprint(1));
    const same = await erasedThenUndone(fingerprint(0));
    const result = await pass(await cutoverAt(), null, 16);
    expect(result.outcomes).toMatchObject({
      retired: 1,
      kept_same_content: 1,
    });
    expect(result.keptUnproven).toBe(0);
    expect(result.next).toBeNull();
    expect(await stateOf(other.entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await intentOf(other.revision)).toMatchObject({
      status: "cleanup_pending",
      lastError: "projection revision retired as not provably current",
    });
    expect(await stateOf(same.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(same.revision),
    });
    // A first append from here: the retired copy is ordinary cleanup.
    expect((await claim()).claimed.unserved).toBe(1);
  });

  test("keeps a copy two plain content changes behind, with no recorded erasure, served and counted as unproven", async () => {
    const changed = await servedEntity();
    await changeDesired(changed.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await changeDesired(changed.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });
    const instant = await cutoverAt();
    for (const mode of ["count", "retire"] as const) {
      // db-await-in-loop: one run per mode, the same decision in both
      const result = await pass(instant, null, 16, mode);
      expect(result.outcomes).toMatchObject({ retired: 0 });
      expect(result.keptUnproven).toBe(1);
      expect(result.scanned).toBe(1);
    }
    await stillServed(changed);
    expect((await claim()).claimed.unserved).toBe(0);
  });

  test("a withdrawal recorded outside the copy's window is no evidence", async () => {
    // Recorded before the copy was reserved: the copy holds content desired
    // after it.
    const earlier = await servedEntity({ beforeReservation: recordWithdrawal });
    // Recorded after the cutover: this release's write.
    const later = await servedEntity();
    for (const { entityId } of [earlier, later]) {
      // db-await-in-loop: two desired changes per entity, in order
      await changeDesired(entityId, 2, { action: "erase" });
      // db-await-in-loop: two desired changes per entity, in order
      await changeDesired(entityId, 3, {
        action: "upsert",
        fingerprint: fingerprint(1),
      });
    }
    const instant = await cutoverAt();
    await recordWithdrawal(later.entityId);

    const result = await pass(instant, null, 16);
    expect(result.outcomes).toMatchObject({ retired: 0 });
    expect(result.keptUnproven).toBe(2);
    await stillServed(earlier);
    await stillServed(later);
  });

  test("never retires a legislation copy, which records no withdrawal", async () => {
    const served = await legislation.servedEntity();
    await legislation.changeDesired(served.entityId, 2, { action: "erase" });
    await legislation.changeDesired(served.entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    // Even a withdrawal row in the legislation trail, which no production
    // writer produces, is not read.
    await legislation.run(sql`
      INSERT INTO legislation_index_jobs (
        id, document_id, generation, operation, status
      ) VALUES (
        ${legislation.uuid()}, ${served.entityId}, ${legislation.generation},
        'withdraw', 'succeeded'
      )
    `);
    const instant = await cutoverAt();
    for (const mode of ["count", "retire"] as const) {
      // db-await-in-loop: one run per mode
      const result = await pass(instant, null, 16, mode, legislation);
      expect(result.outcomes).toMatchObject({ retired: 0 });
      expect(result.keptUnproven).toBe(1);
    }
    expect(await legislation.stateOf(served.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(served.revision),
    });
    expect(await legislation.intentOf(served.revision)).toMatchObject({
      status: "applied",
    });
  });

  test("retires a copy the previous release kept through an erasure and its undo, after this release rewrote the state", async () => {
    const legacy = await erasedThenUndone(fingerprint(1));
    const undoneAt = await desiredAtOf(legacy.entityId);
    const instant = await cutoverAt();
    // After the cutover, this release reconciles the state to the canonical
    // content and then re-projects it at a newer epoch with that content.
    await thisReleaseReconciles(legacy.entityId);
    await thisReleaseReprojects(legacy.entityId);
    expect(await stateOf(legacy.entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(legacy.revision),
    });
    // Neither write moved the instant the copy fell two changes behind.
    expect(await desiredAtOf(legacy.entityId)).toEqual(undoneAt);

    const result = await pass(instant, null, 16);
    expect(result.outcomes).toMatchObject({
      retired: 1,
      kept_after_cutover: 0,
    });
    expect(await stateOf(legacy.entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await intentOf(legacy.revision)).toMatchObject({
      status: "cleanup_pending",
      lastError: "projection revision retired as not provably current",
    });
  });

  test("resumes page by page and keeps a copy only this release's changes moved two or more behind", async () => {
    const before = [
      await erasedThenUndone(fingerprint(1)),
      await erasedThenUndone(fingerprint(2)),
      await erasedThenUndone(fingerprint(3)),
    ];
    const singleChange = await servedEntity();
    await changeDesired(singleChange.entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    const instant = await cutoverAt();
    // Three content changes, all written by this release after the cutover.
    const after = await servedEntity();
    await thisReleaseChanges(after.entityId, fingerprint(1));
    await thisReleaseChanges(after.entityId, fingerprint(2));
    await thisReleaseChanges(after.entityId, fingerprint(3));

    let cursor: LegacyServedCopyRetireCursor | null = null;
    const totals = { retired: 0, kept_after_cutover: 0, kept_one_change: 0 };
    for (let page = 0; page < 10; page += 1) {
      // db-await-in-loop: each page resumes from the previous page's cursor
      const result = await pass(instant, cursor, 1);
      totals.retired += result.outcomes.retired;
      totals.kept_after_cutover += result.outcomes.kept_after_cutover;
      totals.kept_one_change += result.outcomes.kept_one_change;
      cursor = result.next;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor).toBeNull();
    expect(totals).toEqual({
      retired: 3,
      kept_after_cutover: 1,
      kept_one_change: 1,
    });
    for (const { entityId } of before) {
      // db-await-in-loop: one state per assertion
      expect((await stateOf(entityId)).appliedRevision).toBeNull();
    }
    expect(await stateOf(after.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(after.revision),
    });
    expect(await intentOf(after.revision)).toMatchObject({ status: "applied" });
    expect(await stateOf(singleChange.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(
        singleChange.revision,
      ),
    });
    // Run again from the start: nothing left to retire.
    expect((await pass(instant, null, 16)).outcomes.retired).toBe(0);
  });

  test("counts what it would retire and writes nothing", async () => {
    const legacy = await erasedThenUndone(fingerprint(1));
    const instant = await cutoverAt();
    const counted = await pass(instant, null, 16, "count");
    expect(counted.outcomes).toMatchObject({ retired: 1 });
    expect(await stateOf(legacy.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(legacy.revision),
    });
    expect(await intentOf(legacy.revision)).toMatchObject({
      status: "applied",
    });
    expect((await pass(instant, null, 16)).outcomes).toMatchObject({
      retired: 1,
    });
  });

  test("refuses a cutover later than the database clock", async () => {
    const legacy = await erasedThenUndone(fingerprint(1));
    const future = (await cutoverAt()).add({ hours: 1 });
    for (const mode of ["count", "retire"] as const) {
      // db-await-in-loop: one refusal per mode
      expect(
        await pass(future, null, 16, mode).then(
          () => "accepted",
          (error: unknown) => (error instanceof Error ? error.message : ""),
        ),
      ).toContain("cutover is later than the database clock");
    }
    expect(await intentOf(legacy.revision)).toMatchObject({
      status: "applied",
    });
  });

  test("refuses to resume a walk under another cutover than its cursor carries", async () => {
    const first = await erasedThenUndone(fingerprint(1));
    const second = await erasedThenUndone(fingerprint(2));
    const instant = await cutoverAt();
    const page = await pass(instant, null, 1);
    const cursor = page.next ?? panic("The walk ended after one page");
    expect(cursor.cutoverAt).toBe(instant.toString());
    expect(await stateOf(first.entityId)).toMatchObject({
      appliedRevision: null,
    });

    for (const other of [
      instant.subtract({ milliseconds: 1 }),
      instant.add({ milliseconds: 1 }),
    ]) {
      for (const mode of ["count", "retire"] as const) {
        // db-await-in-loop: one refusal per instant and mode
        const refusal = await passResult(other, cursor, 1, mode);
        expect(refusal.isErr() ? refusal.error : null).toBeInstanceOf(
          LegacyServedCopyRetireCutoverMismatchError,
        );
      }
    }
    expect(await intentOf(second.revision)).toMatchObject({
      status: "applied",
    });

    // The same instant, however it is spelled, resumes the walk.
    const resumed = await pass(
      Temporal.Instant.from(cursor.cutoverAt),
      cursor,
      1,
    );
    expect(resumed.outcomes).toMatchObject({ retired: 1 });
    expect((await stateOf(second.entityId)).appliedRevision).toBeNull();
  });

  test("an erasure written after the cutover stamps its own instant, and its undo retires the copy", async () => {
    const legacy = await erasedThenUndone(fingerprint(1));
    const undoneAt = await desiredAtOf(legacy.entityId);
    const instant = await cutoverAt();
    // This release erases the state while it is two changes behind its copy:
    // the erasure is pending from its own write, not from the undo before it.
    await run(sql`
      UPDATE case_law_decisions
      SET content_hash = ${EMPTY_CORPUS_CONTENT_HASHES[0] ?? panic("No empty hash")}
      WHERE id = ${legacy.entityId}
    `);
    await thisReleaseReprojects(legacy.entityId);
    expect(await stateOf(legacy.entityId)).toMatchObject({
      desiredAction: "erase",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(legacy.revision),
    });
    const erasedAt = await desiredAtOf(legacy.entityId);
    expect(erasedAt.getTime()).toBeGreaterThan(undoneAt.getTime());
    expect(erasedAt.getTime()).toBeGreaterThanOrEqual(
      instant.epochMilliseconds,
    );

    // Its undo is this release's too, which retires the copy at once.
    await thisReleaseChanges(legacy.entityId, fingerprint(2));
    expect(await stateOf(legacy.entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await intentOf(legacy.revision)).toMatchObject({
      status: "cleanup_pending",
      lastError: "projection revision retired by an undone erasure",
    });
    expect((await pass(instant, null, 16)).scanned).toBe(0);
  });

  test("keeps a copy applied at or after the cutover whatever instant its state records", async () => {
    const legacy = await erasedThenUndone(fingerprint(1));
    await previousPrepare(legacy.entityId, legacy.revision);
    const instant = await cutoverAt();
    // After the cutover the state names a fresh copy, and its desired value
    // then moves two changes past it with the recorded instant left before
    // the cutover, the shape a switch would keep had the desired value moved
    // during the fresh copy's flight.
    const fresh = await namesFreshCopy(legacy.entityId);
    const before = await desiredAtOf(legacy.entityId);
    await changeDesired(
      legacy.entityId,
      4,
      { action: "upsert", fingerprint: fingerprint(2) },
      { desiredAtRecorded: false },
    );
    await changeDesired(
      legacy.entityId,
      5,
      { action: "upsert", fingerprint: fingerprint(3) },
      { desiredAtRecorded: false },
    );
    expect(await desiredAtOf(legacy.entityId)).toEqual(before);
    expect(before.getTime()).toBeLessThan(instant.epochMilliseconds);

    const result = await pass(instant, null, 16);
    expect(result.outcomes).toMatchObject({
      retired: 0,
      kept_after_cutover: 1,
    });
    expect(await stateOf(legacy.entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(fresh),
    });
    expect(await intentOf(fresh)).toMatchObject({ status: "applied" });
  });

  test("skips a state the state guard refuses to write and carries on", async () => {
    const trailing = await erasedThenUndone(fingerprint(1));
    const legacy = await erasedThenUndone(fingerprint(2));
    // The canonical row moved on without this generation's state, as it does
    // for a generation that only takes erasures: the guard refuses every
    // write of that state.
    await run(sql`
      UPDATE case_law_decisions SET projection_epoch = 9
      WHERE id = ${trailing.entityId}
    `);
    const instant = await cutoverAt();

    const first = await pass(instant, null, 16);
    expect(first.outcomes).toMatchObject({
      retired: 1,
      skipped_canonical_epoch: 1,
    });
    expect(first.skipped).toEqual([
      { entityId: trailing.entityId, reason: "canonical_epoch" },
    ]);
    expect((await stateOf(legacy.entityId)).appliedRevision).toBeNull();
    expect(await intentOf(trailing.revision)).toMatchObject({
      status: "applied",
    });
    // The walk is not wedged: a second run reports the same state again.
    expect((await pass(instant, null, 16)).outcomes).toMatchObject({
      retired: 0,
      skipped_canonical_epoch: 1,
    });
  });
});
