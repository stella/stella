import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  failedDecisionText,
  FULLTEXT_RECOVERY_LIMITS,
  pendingDecisionText,
} from "./fulltext-state";
import {
  adoptLegacyDecisionTextStates,
  claimDecisionTextWork,
  scheduleStaleDecisionTextProof,
  settleDecisionTextWork,
} from "./fulltext-state-store";

const now = new Date("2026-10-28T12:00:00.000Z");
const sourceId = createSafeId<"caseLawSource">();
let client: Awaited<ReturnType<typeof createTestPglite>>;
const connect = (connection: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client: connection });
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (work) =>
  await db.transaction(async (tx) => await work(asTestRaw(tx)));
const workOptions = { scopedDb, sourceId, now };
const listing = { type: "publisher_listing", slice: "2014", page: 9 } as const;
const seed = async (count = 1) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: createSafeId<"caseLawDecision">(),
    sourceId,
    country: "CZE",
    court: "Test court",
    language: "cs",
    caseNumber: `5 As ${index}/2014`,
    sourceHash: "a".repeat(64),
    sourceObservationOrder: 1n,
    textState: pendingDecisionText({
      now,
      attemptCount: 0,
      lastAttemptAt: null,
      delayMs: 0,
      recovery: listing,
    }),
  }));
  await db.insert(caseLawDecisions).values(rows);
  return rows;
};
const oneClaim = async () =>
  (await claimDecisionTextWork(workOptions)).at(0) ??
  panic("Expected one queued decision");
const failure = () =>
  failedDecisionText({
    now,
    attemptCount: 1,
    cause: { kind: "network", code: "reset" },
    retryFloorMs: 0,
    recovery: listing,
  });

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
});
afterAll(async () => await client.close());
beforeEach(async () => {
  await db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
});

describe.serial("durable decision text recovery store", () => {
  test("legacy adoption reaches a fixed point without reading pointer-only rows as stored", async () => {
    const [row] = await seed();
    if (row === undefined) {
      panic("Missing seed row");
    }
    const migration = readFileSync(
      new URL(
        "../../../drizzle/20261028160000_case_law_fulltext_state/migration.sql",
        import.meta.url,
      ),
      "utf-8",
    );
    const check =
      migration
        .split("--> statement-breakpoint")
        .find((statement) =>
          statement
            .trim()
            .startsWith("ALTER TABLE public.case_law_decisions ADD CONSTRAINT"),
        ) ?? panic("Missing production text-state check");
    await db.transaction(async (tx) => {
      // Seed an untouched pre-migration row, then restore the production fence.
      await tx.execute(
        sql`ALTER TABLE case_law_decisions DISABLE TRIGGER case_law_decisions_text_state_guard`,
      );
      await tx.execute(
        sql`ALTER TABLE case_law_decisions DROP CONSTRAINT case_law_decisions_text_state_valid`,
      );
      await tx.execute(
        sql`UPDATE case_law_decisions SET text_state=NULL, text_s3_key='pointer-only' WHERE id=${row.id}`,
      );
      await tx.execute(sql.raw(check));
      await tx.execute(
        sql`ALTER TABLE case_law_decisions ENABLE TRIGGER case_law_decisions_text_state_guard`,
      );
    });
    expect(await adoptLegacyDecisionTextStates(workOptions)).toBe(1);
    expect(await adoptLegacyDecisionTextStates(workOptions)).toBe(0);
    const result = await db
      .select({ state: caseLawDecisions.textState })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, row.id));
    expect(result.at(0)?.state).toMatchObject({
      status: "fetch_pending",
      recovery: { type: "verify_storage" },
    });
  });
  test("independent claimers do not overlap and abandoned leases expire", async () => {
    await seed(FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH * 2);
    const first = await claimDecisionTextWork(workOptions);
    const second = await claimDecisionTextWork(workOptions);
    expect(first).toHaveLength(FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH);
    expect(second).toHaveLength(FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(
      first.length + second.length,
    );
    expect(await claimDecisionTextWork(workOptions)).toEqual([]);
    const expired = await claimDecisionTextWork({
      ...workOptions,
      now: new Date(now.getTime() + FULLTEXT_RECOVERY_LIMITS.CLAIM_MS + 1),
    });
    expect(expired).toHaveLength(FULLTEXT_RECOVERY_LIMITS.VERIFICATION_BATCH);
    expect(
      expired.every(
        (row) =>
          row.textState.attemptCount === 2 &&
          row.textState.recovery.type === "publisher_listing" &&
          row.textState.recovery.page === 9,
      ),
    ).toBe(true);
  });
  test("failure settlement preserves the publisher listing checkpoint and rejects duplicate completion", async () => {
    await seed();
    const claimed = await oneClaim();
    expect(
      await settleDecisionTextWork({
        scopedDb,
        claimed,
        state: failure(),
        observationOrder: claimed.sourceObservationOrder,
      }),
    ).toBe(true);
    expect(
      await settleDecisionTextWork({
        scopedDb,
        claimed,
        state: failure(),
        observationOrder: claimed.sourceObservationOrder,
      }),
    ).toBe(false);
    const result = await db
      .select({ state: caseLawDecisions.textState })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, claimed.id));
    expect(result.at(0)?.state).toMatchObject({
      status: "fetch_failed",
      recovery: listing,
    });
  });
  test("a newer publisher revision rejects the old source-order and hash completion", async () => {
    await seed();
    const claimed = await oneClaim();
    await db
      .update(caseLawDecisions)
      .set({ sourceHash: "b".repeat(64), sourceObservationOrder: 2n })
      .where(eq(caseLawDecisions.id, claimed.id));
    expect(
      await settleDecisionTextWork({
        scopedDb,
        claimed,
        state: failure(),
        observationOrder: claimed.sourceObservationOrder,
      }),
    ).toBe(false);
  });
  test("periodic verification queues only an aged proof once and leaves fresh/boundary proofs intact", async () => {
    const rows = await seed(3);
    const stamps = [
      new Date(
        now.getTime() - FULLTEXT_RECOVERY_LIMITS.STORED_VERIFICATION_MS - 1,
      ).toISOString(),
      now.toISOString(),
      new Date(
        now.getTime() - FULLTEXT_RECOVERY_LIMITS.STORED_VERIFICATION_MS,
      ).toISOString(),
    ];
    for (const [index, row] of rows.entries()) {
      const verifiedAt =
        stamps.at(index) ?? panic("Missing proof fixture timestamp");
      await db
        .update(caseLawDecisions)
        .set({
          fulltext: "Readable stored decision text",
          textState: {
            status: "stored",
            storage: "postgres",
            contentHash: "a".repeat(64),
            verifiedAt,
          },
        })
        .where(eq(caseLawDecisions.id, row.id));
    }
    expect(await scheduleStaleDecisionTextProof(workOptions)).toBe(1);
    expect(await scheduleStaleDecisionTextProof(workOptions)).toBe(0);
    const claimed = await claimDecisionTextWork(workOptions);
    expect(claimed).toHaveLength(1);
    expect(claimed.at(0)?.id).toBe(rows.at(0)?.id);
    expect(claimed.at(0)?.textState).toMatchObject({
      status: "fetch_pending",
      attemptCount: 1,
      recovery: { type: "verify_storage" },
      lastAttemptAt: now.toISOString(),
    });
    expect(claimed.at(0)?.fulltext).toBe("Readable stored decision text");
    expect(await claimDecisionTextWork(workOptions)).toEqual([]);
    for (const [index, row] of rows.entries()) {
      if (index === 0) {
        continue;
      }
      const result = await db
        .select({ state: caseLawDecisions.textState })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, row.id));
      expect(result.at(0)?.state).toMatchObject({
        status: "stored",
        verifiedAt: stamps.at(index),
      });
    }
  });
  test("erasure rejects an outstanding completion", async () => {
    await seed();
    const claimed = await oneClaim();
    await db
      .update(caseLawDecisions)
      .set({ redactedAt: now })
      .where(eq(caseLawDecisions.id, claimed.id));
    expect(
      await settleDecisionTextWork({
        scopedDb,
        claimed,
        state: failure(),
        observationOrder: claimed.sourceObservationOrder,
      }),
    ).toBe(false);
    const result = await db
      .select({ state: caseLawDecisions.textState })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, claimed.id));
    expect(result.at(0)?.state).toBeNull();
  });
});
