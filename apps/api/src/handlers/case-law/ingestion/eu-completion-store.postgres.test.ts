import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  databaseBackfillStates,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
  euCompletionRequestHours,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

import {
  createEuCompletionStore,
  EU_COMPLETION_STORE_LIMITS,
  type EuCompletionReceipt,
} from "./eu-completion-store";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const hash = (payload: string) =>
  new Bun.CryptoHasher("sha256").update(payload).digest("hex");

if (!databaseUrl || !enabled) {
  describe.skip("durable EU completion receipts", () => {
    test("requires fixture Postgres", () =>
      expect(enabled && Boolean(databaseUrl)).toBe(false));
  });
} else {
  describe("durable EU completion receipts", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceIds: ReturnType<typeof createSafeId<"caseLawSource">>[] = [];
    cleanUp(async () => {
      for (const sourceId of sourceIds) {
        await db
          .delete(euCompletionApprovals)
          .where(eq(euCompletionApprovals.sourceId, sourceId));
        await db
          .delete(euCompletionControls)
          .where(eq(euCompletionControls.sourceId, sourceId));
        await db
          .delete(euCompletionReceipts)
          .where(eq(euCompletionReceipts.sourceId, sourceId));
        await db
          .delete(databaseBackfillStates)
          .where(
            sql`${databaseBackfillStates.name} LIKE ${`${escapeLike(`eu-completion:${sourceId}:`)}%`}`,
          );
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
      await db
        .delete(euCompletionControls)
        .where(eq(euCompletionControls.key, "global"));
      await db
        .delete(euCompletionRequestHours)
        .where(
          eq(euCompletionRequestHours.hour, new Date(Date.UTC(2001, 0, 1))),
        );
    });
    const fixture = async () => {
      const sourceId = createSafeId<"caseLawSource">();
      sourceIds.push(sourceId);
      const ids = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `completion-${sourceId}`,
        name: "completion fixture",
      });
      await db.insert(caseLawDecisions).values(
        ids.map((id) => ({
          id,
          sourceId,
          caseNumber: id,
          country: "EUR",
          court: "fixture",
          language: "en",
          parserVersion: 1,
          sourceHash: "before",
        })),
      );
      let time = Date.UTC(2026, 9, 2);
      const store = createEuCompletionStore({ db, now: () => time });
      const options = {
        sourceId,
        mode: "dry-run" as const,
        parserVersion: 2,
        limit: 1,
      };
      const receipt = (await store.reserve(options)).at(0);
      if (!receipt) {
        throw new TypeError("Expected completion reservation");
      }
      return {
        sourceId,
        ids,
        store,
        receipt,
        options,
        advance: (duration: number) => {
          time += duration;
        },
        currentTime: () => time,
      };
    };
    const fetched = async (
      store: ReturnType<typeof createEuCompletionStore>,
      receipt: EuCompletionReceipt,
    ) => {
      const payload = JSON.stringify({
        raw: "fixture-base64",
        fingerprint: "claimed",
      });
      expect(await store.pickup(receipt.id)).toBe("ready");
      const result = await store.markFetched({
        id: receipt.id,
        payload,
        payloadHash: hash(payload),
        claimedFingerprint: "claimed",
        target: "full",
        provenance: { requestHashes: [], requestedSurfaces: ["notice"] },
      });
      if (!result) {
        throw new TypeError("Expected fetched receipt");
      }
      return result;
    };
    const approve = async (
      fixtureState: Awaited<ReturnType<typeof fixture>>,
    ) => {
      await fetched(fixtureState.store, fixtureState.receipt);
      await fixtureState.store.finish({
        id: fixtureState.receipt.id,
        status: "dry-run",
      });
      return await fixtureState.store.approveSupervisedDryRun({
        sourceId: fixtureState.sourceId,
        parserVersion: 2,
        supervisedReceiptId: fixtureState.receipt.id,
        evidenceRef: "fixture://supervised-run",
        supervisedBy: "fixture-supervisor",
        supervisedAt: new Date(fixtureState.currentTime()),
        approvedBy: "fixture-operator",
        approvedAt: new Date(fixtureState.currentTime()),
      });
    };
    test("reservation/CAS recovery is idempotent and durable before the cursor moves", async () => {
      const state = await fixture();
      const restarted = createEuCompletionStore({ db, now: state.currentTime });
      expect((await restarted.reserve(state.options)).at(0)?.id).toBe(
        state.receipt.id,
      );
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(
              databaseBackfillStates.name,
              `eu-completion:${state.sourceId}:dry-run:2`,
            ),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBe(state.receipt.decisionId);
      await fetched(state.store, state.receipt);
      await state.store.finish({ id: state.receipt.id, status: "dry-run" });
      const next = (await restarted.reserve(state.options)).at(0);
      expect(next?.decisionId).not.toBe(state.receipt.decisionId);
      expect(
        (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, state.receipt.decisionId))
        ).at(0)?.sourceHash,
      ).toBe("before");
    });
    test("supervised approval survives restart, remains generation-scoped and grants no controls", async () => {
      const state = await fixture();
      await state.store.setControl({
        sourceId: null,
        state: "off",
        changedBy: "fixture",
        changedAt: new Date(state.currentTime()),
      });
      const approved = await approve(state);
      const restarted = createEuCompletionStore({ db, now: state.currentTime });
      expect(
        await restarted.getApproval({
          sourceId: state.sourceId,
          parserVersion: 2,
        }),
      ).toEqual(approved);
      expect(
        await restarted.getApproval({
          sourceId: state.sourceId,
          parserVersion: 3,
        }),
      ).toBeNull();
      expect(await restarted.loadControls(state.sourceId)).toEqual({
        global: "off",
        source: "off",
      });
      expect(
        await db.transaction(
          async (tx) =>
            await restarted.assertApprovalTx(tx, {
              sourceId: state.sourceId,
              parserVersion: 2,
            }),
        ),
      ).toBe(false);
    });
    test("canonical marker is atomic, pending mirrors cannot settle, and completion is exactly once", async () => {
      const state = await fixture();
      await approve(state);
      for (const sourceId of [null, state.sourceId]) {
        await state.store.setControl({
          sourceId,
          state: "on",
          changedBy: "fixture",
          changedAt: new Date(state.currentTime()),
        });
      }
      const receipt = (
        await state.store.reserve({ ...state.options, mode: "apply" })
      ).at(0);
      if (!receipt) {
        throw new TypeError("Expected apply receipt");
      }
      await fetched(state.store, receipt);
      await db.transaction(async (tx) => {
        expect(await state.store.assertApprovalTx(tx, receipt)).toBe(true);
        await tx
          .update(caseLawDecisions)
          .set({
            sourceHash: "semantic-hash",
            parserVersion: 2,
            sourceObservationOrder: 42n,
            corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
          })
          .where(eq(caseLawDecisions.id, receipt.decisionId));
        await state.store.markWrittenTx(tx, {
          id: receipt.id,
          decisionId: receipt.decisionId,
        });
      });
      expect(await state.store.finalize(receipt.id)).toBe("retryable");
      expect((await state.store.getReceipt(receipt.id)).payload).not.toBeNull();
      await db
        .update(caseLawDecisions)
        .set({ corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED })
        .where(eq(caseLawDecisions.id, receipt.decisionId));
      expect(await state.store.finalize(receipt.id)).toBe("applied");
      expect(await state.store.finalize(receipt.id)).toBe("applied");
      const progress = (
        await db
          .select()
          .from(euCompletionControls)
          .where(eq(euCompletionControls.sourceId, state.sourceId))
      ).at(0);
      expect(progress?.completedRows).toBe(1);
    });
    test("an unrelated observation with the same semantic hash requires review", async () => {
      const state = await fixture();
      await approve(state);
      for (const sourceId of [null, state.sourceId]) {
        await state.store.setControl({
          sourceId,
          state: "on",
          changedBy: "fixture",
          changedAt: new Date(state.currentTime()),
        });
      }
      const receipt = (
        await state.store.reserve({ ...state.options, mode: "apply" })
      ).at(0);
      if (!receipt) {
        throw new TypeError("Expected apply observation fixture");
      }
      await fetched(state.store, receipt);
      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({
            sourceHash: "same-semantic-hash",
            parserVersion: 2,
            sourceObservationOrder: 42n,
          })
          .where(eq(caseLawDecisions.id, receipt.decisionId));
        await state.store.markWrittenTx(tx, {
          id: receipt.id,
          decisionId: receipt.decisionId,
        });
      });
      await db
        .update(caseLawDecisions)
        .set({ sourceObservationOrder: 43n })
        .where(eq(caseLawDecisions.id, receipt.decisionId));
      expect(await state.store.finalize(receipt.id)).toBe("review-required");
      expect((await state.store.getReceipt(receipt.id)).status).toBe(
        "review-required",
      );
    });
    test("publisher refusal persists a future source hold and unchanged settles without a decision write", async () => {
      const state = await fixture();
      const retryAt = new Date(
        state.currentTime() + EU_COMPLETION_STORE_LIMITS.retryMaxMs,
      );
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      await state.store.finish({
        id: state.receipt.id,
        status: "publisher-refused",
        retryAt,
      });
      expect(
        (await state.store.loadSourceGateState(state.sourceId)).holdUntil,
      ).toBe(retryAt.getTime());
      expect((await state.store.getReceipt(state.receipt.id)).status).toBe(
        "publisher-refused",
      );
      const paused = await state.store.getReceipt(state.receipt.id);
      expect(paused.attempts).toBe(0);
      expect(paused.completedAt).toBeNull();
      expect(await state.store.pickup(state.receipt.id)).toBe("waiting");
      state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
      const resumed = (await state.store.reserve(state.options)).at(0);
      expect(resumed?.id).toBe(state.receipt.id);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(1);
      await state.store.finish({ id: state.receipt.id, status: "unchanged" });
      const next = (await state.store.reserve(state.options)).at(0);
      if (!next) {
        throw new TypeError("Expected next durable identity");
      }
      await state.store.finish({ id: next.id, status: "unchanged" });
      expect((await state.store.getReceipt(next.id)).status).toBe("unchanged");
      expect(
        (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, next.decisionId))
        ).at(0)?.sourceHash,
      ).toBe("before");
    });
    test("fetched retry payload survives cancellation and duplicate failures never refund old attempts", async () => {
      const state = await fixture();
      const receipt = await fetched(state.store, state.receipt);
      const failure = {
        scope: "systemic",
        code: "cancelled",
        healthyEvidence: "none",
      } as const;
      expect(await state.store.recordFailure(receipt, failure)).toBe(
        "retryable",
      );
      expect(await state.store.recordFailure(receipt, failure)).toBe(
        "retryable",
      );
      const saved = await state.store.getReceipt(receipt.id);
      expect(saved.payload).toBe(receipt.payload);
      expect(saved.attempts).toBe(0);
      state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
      expect(await state.store.pickup(receipt.id)).toBe("ready");
      expect((await state.store.getReceipt(receipt.id)).status).toBe("fetched");
    });
    test("crashed pickup is bounded and failed receipts re-enter after seven days", async () => {
      const state = await fixture();
      for (let i = 0; i < EU_COMPLETION_STORE_LIMITS.maxAttempts; i++) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
      }
      expect(await state.store.pickup(state.receipt.id)).toBe("failed");
      state.advance(EU_COMPLETION_STORE_LIMITS.readmissionDays * DAY_IN_MS);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(1);
    });
    test("a true outage consumes no row attempts; adjacent healthy evidence isolates only a bounded streak", async () => {
      const state = await fixture();
      const failure = {
        scope: "systemic",
        code: "timeout",
        healthyEvidence: "none",
      } as const;
      for (let i = 0; i < 6; i++) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        expect(await state.store.recordFailure(state.receipt, failure)).toBe(
          "retryable",
        );
        state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
      }
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(0);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      expect(
        await state.store.recordFailure(state.receipt, {
          ...failure,
          healthyEvidence: "adjacent-row",
        }),
      ).toBe("isolated");
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(1);
    });
    test("hour budget serializes independent clients at the last request", async () => {
      const state = await fixture();
      const hour = new Date(Date.UTC(2001, 0, 1));
      await db
        .insert(euCompletionRequestHours)
        .values({ hour, requests: 3599 })
        .onConflictDoUpdate({
          target: euCompletionRequestHours.hour,
          set: { requests: 3599 },
        });
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const one = createEuCompletionStore({
          db: openClient({ max: 1 }).db,
          now: state.currentTime,
        });
        const two = createEuCompletionStore({
          db: openClient({ max: 1 }).db,
          now: state.currentTime,
        });
        const results = await Promise.all([
          one.reserveRequest({ sourceId: state.sourceId, hour }),
          two.reserveRequest({ sourceId: state.sourceId, hour }),
        ]);
        expect(results.toSorted()).toEqual([false, true]);
        expect(
          (
            await db
              .select()
              .from(euCompletionRequestHours)
              .where(eq(euCompletionRequestHours.hour, hour))
          ).at(0)?.requests,
        ).toBe(3600);
      });
    });
    test("superseded terminal receipts compact while a newer target identity stays permanent", async () => {
      const state = await fixture();
      await fetched(state.store, state.receipt);
      await state.store.finish({ id: state.receipt.id, status: "dry-run" });
      state.advance(100 * DAY_IN_MS);
      const newer = (
        await state.store.reserve({ ...state.options, parserVersion: 3 })
      ).at(0);
      if (!newer) {
        throw new TypeError("Expected next generation receipt");
      }
      expect(newer.decisionId).toBe(state.receipt.decisionId);
      expect(newer.id).not.toBe(state.receipt.id);
      expect(await state.store.compact({ limit: 100 })).toBe(1);
      expect(await state.store.getReceipt(newer.id)).not.toBeNull();
      expect(await state.store.compact({ limit: 100 })).toBe(0);
    });
    test("compaction preserves latest and approval evidence forever", async () => {
      const state = await fixture();
      await approve(state);
      state.advance(100 * DAY_IN_MS);
      await db
        .update(euCompletionReceipts)
        .set({ supersededAt: new Date(state.currentTime() - 100 * DAY_IN_MS) })
        .where(eq(euCompletionReceipts.id, state.receipt.id));
      expect(await state.store.compact({ limit: 100 })).toBe(0);
      expect(await state.store.getReceipt(state.receipt.id)).not.toBeNull();
      const newer = (await state.store.reserve(state.options)).at(0);
      if (!newer) {
        throw new TypeError("Expected later receipt");
      }
      await fetched(state.store, newer);
      await state.store.finish({ id: newer.id, status: "dry-run" });
      expect(await state.store.compact({ limit: 100 })).toBe(0);
      expect(
        await db
          .select()
          .from(euCompletionReceipts)
          .where(
            and(
              eq(euCompletionReceipts.sourceId, state.sourceId),
              eq(euCompletionReceipts.id, newer.id),
            ),
          ),
      ).toHaveLength(1);
    });
  });
}
