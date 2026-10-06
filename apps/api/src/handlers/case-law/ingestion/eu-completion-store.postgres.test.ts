import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { initialBatchState } from "@stll/db-load-gate/health";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS } from "@stll/time";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  caseLawIndexJobs,
  databaseBackfillStates,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
  euCompletionRequestHours,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

import {
  buildEuCompletionPageQuery,
  createEuCompletionStore,
  CompletionPayloadTooLarge,
  EU_COMPLETION_STORE_LIMITS,
  type EuCompletionReceipt,
} from "./eu-completion-store";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

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
        payloadHash: hashSha256Hex(payload),
        claimedFingerprint: "claimed",
        target: "full",
        provenance: { requestHashes: [], requestedSurfaces: ["notice"] },
      });
      if (result.isErr() || result.value === null) {
        throw new TypeError("Expected fetched receipt");
      }
      return result.value;
    };
    const approve = async (
      fixtureState: Awaited<ReturnType<typeof fixture>>,
    ) => {
      await fetched(fixtureState.store, fixtureState.receipt);
      await fixtureState.store.finish({
        id: fixtureState.receipt.id,
        status: "dry-run",
      });
      const approval = await fixtureState.store.approveSupervisedDryRun({
        sourceId: fixtureState.sourceId,
        parserVersion: 2,
        supervisedReceiptId: fixtureState.receipt.id,
        evidenceRef: "fixture://supervised-run",
        supervisedBy: "fixture-supervisor",
        supervisedAt: new Date(fixtureState.currentTime()),
        approvedBy: "fixture-operator",
        approvedAt: new Date(fixtureState.currentTime()),
        reviewedCounts: { reviewed: 1, accepted: 1, requiresReview: 0 },
      });
      if (approval.isErr()) {
        throw new TypeError(approval.error.message);
      }
      return approval.value;
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
    test("invalid or duplicate operator approvals return typed business errors", async () => {
      const state = await fixture();
      const approved = await approve(state);
      const other = await fixture();
      const cases = [
        {
          input: {
            ...approved,
            supervisedReceiptId: "missing-fixture-receipt",
          },
          code: "not-found",
        },
        {
          input: { ...approved, sourceId: other.sourceId },
          code: "invalid-proof",
        },
        { input: { ...approved, parserVersion: 3 }, code: "invalid-proof" },
        {
          input: {
            ...approved,
            sourceId: other.sourceId,
            supervisedReceiptId: other.receipt.id,
          },
          code: "invalid-proof",
        },
        {
          input: {
            ...approved,
            reviewedCounts: { reviewed: 0, accepted: 0, requiresReview: 0 },
          },
          code: "invalid-input",
        },
        { input: approved, code: "already-approved" },
      ] as const;
      for (const item of cases) {
        const result = await state.store.approveSupervisedDryRun(item.input);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe(item.code);
        }
      }
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
      const newerDry = (
        await state.store.reserve({ ...state.options, parserVersion: 3 })
      ).at(0);
      if (newerDry === undefined) {
        throw new TypeError("Expected newer dry-run receipt");
      }
      await fetched(state.store, newerDry);
      await state.store.finish({ id: newerDry.id, status: "dry-run" });
      state.advance(100 * DAY_IN_MS);
      await state.store.compact({ limit: 100 });
      expect(
        (await state.store.getReceipt(receipt.id)).supersededAt,
      ).toBeNull();
    });
    test("terminal refusals do not count as queued work or overdue retries", async () => {
      const state = await fixture();
      await db
        .update(euCompletionReceipts)
        .set({
          status: "publisher-refused",
          completedAt: new Date(state.currentTime()),
          completionSourceHash: "before",
          retryAt: null,
        })
        .where(eq(euCompletionReceipts.id, state.receipt.id));
      expect(await state.store.probe(state.options)).toMatchObject({
        hasQueuedWork: false,
        oldestRetryAgeMs: null,
        mirrorRepairRequired: false,
      });
    });
    test("three mirror waits require repair without claiming healthy publisher progress", async () => {
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
      if (receipt === undefined) {
        throw new TypeError("Expected apply receipt");
      }
      await fetched(state.store, receipt);
      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({
            sourceHash: "written",
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
      const before = (
        await db
          .select()
          .from(euCompletionControls)
          .where(eq(euCompletionControls.sourceId, state.sourceId))
      ).at(0)?.healthyRows;
      for (const outcome of [
        "waiting",
        "waiting",
        "review-required",
      ] as const) {
        expect(await state.store.waitForMirror(receipt.id)).toBe(outcome);
        state.advance(EU_COMPLETION_STORE_LIMITS.mirrorWaitMs);
        if (outcome === "waiting") {
          expect(await state.store.pickup(receipt.id)).toBe("ready");
        }
      }
      const terminal = await state.store.getReceipt(receipt.id);
      expect(terminal.mirrorWaits).toBe(3);
      expect(terminal.payload).not.toBeNull();
      expect(terminal.writtenObservationOrder).toBe(42n);
      expect(terminal.detail).toBe("canonical mirror repair required");
      expect(
        (
          await db
            .select()
            .from(euCompletionControls)
            .where(eq(euCompletionControls.sourceId, state.sourceId))
        ).at(0)?.healthyRows,
      ).toBe(before);
      const scope = { ...state.options, mode: "apply" as const };
      expect(await state.store.probe(scope)).toMatchObject({
        mirrorRepairRequired: true,
      });
      await db
        .update(caseLawDecisions)
        .set({
          corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
          sourceObservationOrder: 43n,
        })
        .where(eq(caseLawDecisions.id, receipt.decisionId));
      // The source sweep reaches this terminal row after the other two candidates.
      for (let index = 0; index < 2; index++) {
        const other = (await state.store.reserve(scope)).at(0);
        if (other === undefined) {
          throw new TypeError("Expected adjacent reservation");
        }
        await state.store.finish({ id: other.id, status: "unchanged" });
      }
      const readmitted = await state.store.reserve(scope);
      expect(readmitted.map((row) => row.id)).toEqual([receipt.id]);
      expect(readmitted.at(0)).toMatchObject({
        status: "pending",
        writtenAt: null,
        payload: null,
        claimedSourceHash: "written",
        claimedObservationOrder: 43n,
        mirrorWaits: 0,
      });
      await state.store.finish({ id: receipt.id, status: "unchanged" });
      expect(await state.store.probe(scope)).toMatchObject({
        hasQueuedWork: false,
        mirrorRepairRequired: false,
      });
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
      for (let index = 1; index < state.ids.length; index++) {
        const fresh = (await state.store.reserve(state.options)).at(0);
        if (fresh === undefined) {
          throw new TypeError("Expected fair fresh reservation");
        }
        expect(fresh.id).not.toBe(state.receipt.id);
        await state.store.finish({ id: fresh.id, status: "unchanged" });
      }
      const resumed = (await state.store.reserve(state.options)).at(0);
      expect(resumed?.id).toBe(state.receipt.id);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(1);
      await state.store.finish({ id: state.receipt.id, status: "unchanged" });
      expect(await state.store.reserve(state.options)).toEqual([]);
      expect((await state.store.getReceipt(state.receipt.id)).status).toBe(
        "unchanged",
      );
    });
    test.each(["fresh", "oversized-source-hold"] as const)(
      "publisher refusal caps a huge Retry-After with %s state at one day",
      async (priorHold) => {
        const state = await fixture();
        const oversizedDeadline = state.currentTime() + 315_360_000 * 1000;
        const maximumDeadline =
          state.currentTime() + EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs;
        expect(oversizedDeadline).toBeGreaterThan(maximumDeadline);
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        if (priorHold === "oversized-source-hold") {
          const batch = {
            ...initialBatchState(),
            holdUntil: oversizedDeadline,
          };
          await db
            .insert(euCompletionControls)
            .values({
              key: `source:${state.sourceId}`,
              sourceId: state.sourceId,
              batch,
            })
            .onConflictDoUpdate({
              target: euCompletionControls.key,
              set: { batch },
            });
        }
        const settled = await state.store.finish({
          id: state.receipt.id,
          status: "publisher-refused",
          retryAt: new Date(oversizedDeadline),
        });
        expect(settled?.retryAt?.getTime()).toBe(maximumDeadline);
        expect(settled?.refusalHoldUntil?.getTime()).toBe(maximumDeadline);
        expect(settled?.completedAt).toBeNull();
        expect(settled?.attempts).toBe(0);
        expect(
          (await state.store.loadSourceGateState(state.sourceId)).holdUntil,
        ).toBe(maximumDeadline);
        state.advance(EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs);
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      },
    );
    test("publisher refusal without Retry-After escalates to a day without exhausting systemic attempts", async () => {
      const state = await fixture();
      for (const hours of [1, 2, 4, 8, 16, 24, 24]) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        const settled = await state.store.finish({
          id: state.receipt.id,
          status: "publisher-refused",
          retryAt: new Date(state.currentTime() + 1000),
          healthyEvidence: "adjacent-row",
        });
        expect(settled?.refusalHoldUntil?.getTime()).toBe(
          state.currentTime() + hours * 3_600_000,
        );
        expect(settled?.completedAt).toBeNull();
        expect(settled?.attempts).toBe(0);
        state.advance(hours * 3_600_000);
      }
    });
    test.each(["unchanged", "review-required"] as const)(
      "%s without a publisher fetch never terminally isolates a refusal",
      async (status) => {
        const state = await fixture();
        await state.store.releaseBenign(
          state.receipt.id,
          new Date(state.currentTime() + 1000),
        );
        const healthy = (
          await state.store.reserve({ ...state.options, limit: 3 })
        ).find((receipt) => receipt.id !== state.receipt.id);
        if (healthy === undefined) {
          throw new TypeError("Expected adjacent receipt");
        }
        await state.store.finish({ id: healthy.id, status });
        expect(
          (
            await db
              .select()
              .from(euCompletionControls)
              .where(eq(euCompletionControls.sourceId, state.sourceId))
          ).at(0)?.healthyRows,
        ).toBe(0);
        state.advance(1000);
        for (let count = 1; count <= 4; count++) {
          expect(await state.store.pickup(state.receipt.id)).toBe("ready");
          const settled = await state.store.finish({
            id: state.receipt.id,
            status: "publisher-refused",
            retryAt: new Date(state.currentTime() + 1000),
            healthyEvidence: "adjacent-row",
          });
          expect(settled?.completedAt).toBeNull();
          expect(settled?.refusalCount).toBe(count);
          state.advance(
            (settled?.retryAt?.getTime() ?? state.currentTime()) -
              state.currentTime(),
          );
        }
      },
    );
    test("publisher success before the latest refusal cannot isolate a later publisher-wide refusal", async () => {
      const state = await fixture();
      await state.store.releaseBenign(
        state.receipt.id,
        new Date(state.currentTime() + 1000),
      );
      const healthy = (
        await state.store.reserve({ ...state.options, limit: 3 })
      ).find((receipt) => receipt.id !== state.receipt.id);
      if (healthy === undefined) {
        throw new TypeError("Expected adjacent receipt");
      }
      await state.store.finish({
        id: healthy.id,
        status: "unchanged",
        publisherSuccess: true,
      });
      state.advance(1000);
      for (let count = 1; count <= 4; count++) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        const settled = await state.store.finish({
          id: state.receipt.id,
          status: "publisher-refused",
          retryAt: new Date(state.currentTime() + 1000),
          healthyEvidence: "adjacent-row",
        });
        expect(settled?.completedAt).toBeNull();
        expect(settled?.refusalProgress).toBe(1);
        state.advance(
          (settled?.retryAt?.getTime() ?? state.currentTime()) -
            state.currentTime(),
        );
      }
    });
    test("publisher success after an older refusal expires as isolation evidence on the next refusal", async () => {
      const state = await fixture();
      for (let count = 1; count <= 4; count++) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        const settled = await state.store.finish({
          id: state.receipt.id,
          status: "publisher-refused",
          retryAt: new Date(state.currentTime() + 1000),
        });
        expect(settled?.completedAt).toBeNull();
        if (count === 1) {
          const healthy = (
            await state.store.reserve({ ...state.options, limit: 3 })
          ).find((receipt) => receipt.id !== state.receipt.id);
          if (healthy === undefined) {
            throw new TypeError("Expected adjacent receipt");
          }
          await state.store.finish({
            id: healthy.id,
            status: "unchanged",
            publisherSuccess: true,
          });
        }
        state.advance(
          (settled?.retryAt?.getTime() ?? state.currentTime()) -
            state.currentTime(),
        );
      }
    });
    test("healthy documents progress ahead of a repeatedly refusing document which then quiesces", async () => {
      const state = await fixture();
      for (let count = 1; count <= 3; count++) {
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        const settled = await state.store.finish({
          id: state.receipt.id,
          status: "publisher-refused",
          retryAt: new Date(state.currentTime() + 1000),
        });
        if (settled === null) {
          throw new TypeError("Expected refusal settlement");
        }
        if (count < 3) {
          const fresh = (await state.store.reserve(state.options)).at(0);
          if (fresh === undefined) {
            throw new TypeError("Expected healthy adjacent document");
          }
          expect(fresh.id).not.toBe(state.receipt.id);
          await state.store.finish({
            id: fresh.id,
            status: "unchanged",
            publisherSuccess: true,
          });
          expect(
            (await state.store.loadSourceGateState(state.sourceId)).holdCount,
          ).toBe(0);
        }
        if (count < 3) {
          state.advance(
            (settled.retryAt?.getTime() ?? state.currentTime()) -
              state.currentTime(),
          );
        } else {
          expect(settled.completedAt).not.toBeNull();
          expect(settled.retryAt).toBeNull();
          expect(settled.attempts).toBe(0);
          expect(await state.store.pickup(settled.id)).toBe("waiting");
        }
      }
      for (let page = 0; page < 4; page++) {
        for (const receipt of await state.store.reserve(state.options)) {
          expect(receipt.id).not.toBe(state.receipt.id);
          await state.store.finish({ id: receipt.id, status: "unchanged" });
        }
      }
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: "changed refusal document" })
        .where(eq(caseLawDecisions.id, state.receipt.decisionId));
      let admitted: EuCompletionReceipt | undefined;
      for (let page = 0; page < 4 && admitted === undefined; page++) {
        admitted = (await state.store.reserve(state.options)).at(0);
      }
      expect(admitted?.decisionId).toBe(state.receipt.decisionId);
      expect(admitted?.id).not.toBe(state.receipt.id);
    });
    test("completed dry runs quiesce within their mode and generation", async () => {
      const state = await fixture();
      let receipt: EuCompletionReceipt | undefined = state.receipt;
      for (let index = 0; index < 3; index++) {
        if (receipt === undefined) {
          throw new TypeError("Expected dry receipt");
        }
        await fetched(state.store, receipt);
        await state.store.finish({ id: receipt.id, status: "dry-run" });
        receipt = (await state.store.reserve(state.options)).at(0);
      }
      for (let page = 0; page < 4; page++) {
        expect(await state.store.reserve(state.options)).toEqual([]);
      }
      expect(
        (await state.store.reserve({ ...state.options, parserVersion: 3 }))
          .length,
      ).toBe(1);
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
      expect(saved.payload).toEqual(receipt.payload);
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
    test("publisher outages never exhaust rows; isolated storage failures retain a bounded attempt", async () => {
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
      ).toBe("retryable");
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(0);
      for (let index = 0; index < 3; index++) {
        state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
        expect(await state.store.pickup(state.receipt.id)).toBe("ready");
        expect(
          await state.store.recordFailure(state.receipt, {
            scope: "systemic",
            code: "storage",
            healthyEvidence: "adjacent-row",
          }),
        ).toBe(index === 2 ? "isolated" : "retryable");
      }
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(1);
    });
    test("benign stops refund without holding and healthy dry runs clear previous source backoff", async () => {
      const state = await fixture();
      await fetched(state.store, state.receipt);
      const before = (await state.store.getReceipt(state.receipt.id)).payload;
      await state.store.releaseBenign(
        state.receipt.id,
        new Date(state.currentTime() + 60_000),
      );
      expect((await state.store.getReceipt(state.receipt.id)).attempts).toBe(0);
      expect((await state.store.getReceipt(state.receipt.id)).payload).toEqual(
        before,
      );
      expect(
        (await state.store.loadSourceGateState(state.sourceId)).holdCount,
      ).toBe(0);
      expect(await state.store.pickup(state.receipt.id)).toBe("waiting");
      state.advance(60_000);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      await state.store.recordFailure(state.receipt, {
        scope: "systemic",
        code: "publisher",
        healthyEvidence: "adjacent-row",
      });
      expect(
        (await state.store.loadSourceGateState(state.sourceId)).holdCount,
      ).toBe(1);
      state.advance(EU_COMPLETION_STORE_LIMITS.retryMaxMs);
      expect(await state.store.pickup(state.receipt.id)).toBe("ready");
      await state.store.finish({ id: state.receipt.id, status: "dry-run" });
      expect(
        (await state.store.loadSourceGateState(state.sourceId)).holdCount,
      ).toBe(0);
      const completionRuns = async () =>
        await db
          .select()
          .from(systemAuditRuns)
          .where(eq(systemAuditRuns.actor, "system:eu-corpus-completion"));
      const runsBefore = (await completionRuns()).length;
      const idle = {
        attempted: 0,
        applied: 0,
        unchanged: 0,
        reviewRequired: 0,
        failed: 0,
      };
      expect(
        (
          await state.store.recordTick({
            sourceId: state.sourceId,
            mode: "dry-run",
            healthyCompleted: 0,
            intentionallyHeld: false,
            counts: idle,
          })
        ).ticksWithoutProgress,
      ).toBe(0);
      // An idle tick records no system audit run.
      expect(await completionRuns()).toHaveLength(runsBefore);
      for (const mode of ["dry-run", "apply"] as const) {
        const progress = await state.store.recordTick({
          sourceId: state.sourceId,
          mode,
          healthyCompleted: 1,
          intentionallyHeld: false,
          counts: { ...idle, attempted: 1, applied: 1 },
        });
        expect(progress.ticksWithoutProgress).toBe(0);
      }
      const runs = await completionRuns();
      expect(runs).toHaveLength(runsBefore + 2);
      expect(runs.at(-1)?.counts).toEqual({
        ...idle,
        attempted: 1,
        applied: 1,
      });
    });
    test("terminal current hash and parser receipts quiesce across sweep wrap", async () => {
      const state = await fixture();
      const settled = [state.receipt];
      for (let index = 0; index < state.ids.length; index++) {
        const row = settled.at(index);
        if (row === undefined) {
          throw new TypeError("Expected receipt");
        }
        await state.store.finish({ id: row.id, status: "unchanged" });
        const next = (await state.store.reserve(state.options)).at(0);
        if (next !== undefined) {
          settled.push(next);
        }
      }
      expect(await state.store.reserve(state.options)).toEqual([]);
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: "new-crawl-hash" })
        .where(eq(caseLawDecisions.id, state.receipt.decisionId));
      const readmitted: EuCompletionReceipt[] = [];
      // Each reservation examines one bounded page; a changed row re-enters
      // when the sweep reaches it, rather than by scanning the whole source.
      for (const _decisionId of state.ids) {
        readmitted.push(...(await state.store.reserve(state.options)));
        if (readmitted.length > 0) {
          break;
        }
      }
      const next = readmitted.at(0);
      expect(next?.decisionId).toBe(state.receipt.decisionId);
      expect(next?.id).not.toBe(state.receipt.id);
      expect(
        (await state.store.reserve({ ...state.options, parserVersion: 3 }))
          .length,
      ).toBe(1);
    });
    test("crawl supersession refreshes a retry claim instead of becoming a terminal review", async () => {
      const state = await fixture();
      await fetched(state.store, state.receipt);
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: "crawl", sourceObservationOrder: 101n })
        .where(eq(caseLawDecisions.id, state.receipt.decisionId));
      await state.store.finish({
        id: state.receipt.id,
        status: "superseded-by-crawl",
        retryAt: new Date(state.currentTime() + 60_000),
      });
      const held = await state.store.getReceipt(state.receipt.id);
      expect(held.attempts).toBe(0);
      expect(held.completedAt).toBeNull();
      expect(held.payload).toBeNull();
      expect(held.claimedSourceHash).toBe("crawl");
      expect(held.claimedObservationOrder).toBe(101n);
      expect(
        (await state.store.loadSourceGateState(state.sourceId)).holdCount,
      ).toBe(0);
      state.advance(60_000);
      expect((await state.store.reserve(state.options)).at(0)?.id).toBe(
        held.id,
      );
      expect(await state.store.pickup(held.id)).toBe("ready");
    });
    test("withdrawal audit markers exclude queued and fresh reservations", async () => {
      const state = await fixture();
      await db.insert(caseLawIndexJobs).values(
        state.ids.map((decisionId) => ({
          decisionId,
          operation: "withdraw" as const,
          status: "succeeded" as const,
          detail: "fixture withdrawal",
        })),
      );
      expect((await state.store.reserve(state.options)).at(0)?.id).toBe(
        state.receipt.id,
      );
      expect(await state.store.pickup(state.receipt.id)).toBe("waiting");
      expect((await state.store.getReceipt(state.receipt.id)).status).toBe(
        "withdrawn",
      );
      expect(await state.store.reserve(state.options)).toEqual([]);
      expect(
        await state.store.reserve({ ...state.options, parserVersion: 3 }),
      ).toEqual([]);
      await db
        .update(caseLawDecisions)
        .set({ fulltext: "restored document" })
        .where(eq(caseLawDecisions.id, state.receipt.decisionId));
      let restored: EuCompletionReceipt | undefined;
      for (let page = 0; page < 4 && restored === undefined; page++) {
        restored = (await state.store.reserve(state.options)).at(0);
      }
      expect(restored?.decisionId).toBe(state.receipt.decisionId);
      expect(restored?.id).not.toBe(state.receipt.id);
    });
    test("oversize recovery envelopes are typed and leave the receipt unchanged", async () => {
      const state = await fixture();
      const payload = "x".repeat(16 * 1024 * 1024 + 1);
      const saved = await state.store.markFetched({
        id: state.receipt.id,
        payload,
        payloadHash: hashSha256Hex(payload),
        claimedFingerprint: "claimed",
        target: "full",
        provenance: { requestHashes: [], requestedSurfaces: [] },
      });
      expect(saved.isErr()).toBe(true);
      if (saved.isErr()) {
        expect(saved.error).toBeInstanceOf(CompletionPayloadTooLarge);
      }
      expect((await state.store.getReceipt(state.receipt.id)).status).toBe(
        "pending",
      );
    });
    test("owner inserts cannot approve the wrong source, generation, state or completion time", async () => {
      const state = await fixture();
      const approved = await approve(state);
      await db
        .delete(euCompletionApprovals)
        .where(eq(euCompletionApprovals.sourceId, state.sourceId));
      const other = await fixture();
      for (const mismatch of [
        { sourceId: other.sourceId },
        { parserVersion: 3 },
        { proofStatus: "pending" },
        { proofCompletedAt: new Date(approved.proofCompletedAt.getTime() + 1) },
      ]) {
        const inserted = await Result.tryPromise(
          async () =>
            await db
              .insert(euCompletionApprovals)
              .values({ ...approved, ...mismatch }),
        );
        expect(inserted.isErr()).toBe(true);
      }
      const restored = await state.store.approveSupervisedDryRun({
        sourceId: approved.sourceId,
        parserVersion: approved.parserVersion,
        supervisedReceiptId: approved.supervisedReceiptId,
        evidenceRef: approved.evidenceRef,
        supervisedBy: approved.supervisedBy,
        supervisedAt: approved.supervisedAt,
        approvedBy: approved.approvedBy,
        approvedAt: approved.approvedAt,
        reviewedCounts: approved.reviewedCounts,
      });
      expect(restored.isOk()).toBe(true);
    });
    test("approval proofs preserve Postgres microseconds without a Date round trip", async () => {
      const state = await fixture();
      await fetched(state.store, state.receipt);
      await state.store.finish({ id: state.receipt.id, status: "dry-run" });
      await db
        .update(euCompletionReceipts)
        .set({ completedAt: sql`'2026-10-02 00:00:00.123456+00'::timestamptz` })
        .where(eq(euCompletionReceipts.id, state.receipt.id));
      state.advance(1000);
      const approval = await state.store.approveSupervisedDryRun({
        sourceId: state.sourceId,
        parserVersion: 2,
        supervisedReceiptId: state.receipt.id,
        evidenceRef: "fixture://microsecond-proof",
        supervisedBy: "fixture",
        supervisedAt: new Date(state.currentTime()),
        approvedBy: "fixture",
        approvedAt: new Date(state.currentTime()),
        reviewedCounts: { reviewed: 1, accepted: 1, requiresReview: 0 },
      });
      expect(approval.isOk()).toBe(true);
      const proof = (
        await db
          .select({
            microseconds: sql<string>`to_char(${euCompletionApprovals.proofCompletedAt}, 'US')`,
          })
          .from(euCompletionApprovals)
          .where(eq(euCompletionApprovals.sourceId, state.sourceId))
          .limit(1)
      ).at(0);
      expect(proof?.microseconds).toBe("123456");
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
      expect(await state.store.compact({ limit: 100 })).toBe(0);
      await fetched(state.store, newer);
      await state.store.finish({ id: newer.id, status: "dry-run" });
      expect(await state.store.compact({ limit: 100 })).toBe(0);
      expect(
        (
          await state.store.getReceipt(state.receipt.id)
        ).supersededAt?.getTime(),
      ).toBe(state.currentTime());
      state.advance(91 * DAY_IN_MS);
      expect(await state.store.compact({ limit: 100 })).toBe(1);
      expect(await state.store.getReceipt(newer.id)).not.toBeNull();
      expect(await state.store.compact({ limit: 100 })).toBe(0);
    });
    test("finished 100000-row source bounds dry-run selection before receipt filtering", async () => {
      const state = await fixture();
      await db.execute(sql`
        INSERT INTO case_law_decisions (id, source_id, case_number, country, court, language, parser_version, source_hash)
        SELECT md5(${state.sourceId}::text || '-' || n::text)::uuid, ${state.sourceId}::uuid, 'completion-scale-' || n::text, 'EUR', 'fixture', 'en', 2, 'finished'
        FROM generate_series(1, 100000) AS n
      `);
      await db.execute(sql`
        INSERT INTO eu_completion_receipts (id, source_id, decision_id, mode, parser_version, status, completion_source_hash, completed_at)
        SELECT 'finished-' || id::text, source_id, id, 'dry-run', 2, 'dry-run', source_hash, now()
        FROM case_law_decisions WHERE source_id = ${state.sourceId}::uuid
      `);
      await db.execute(sql`
        INSERT INTO case_law_index_jobs (id, decision_id, operation, status)
        SELECT md5('withdrawal-' || id::text)::uuid, id, 'withdraw', 'succeeded'
        FROM case_law_decisions WHERE source_id = ${state.sourceId}::uuid
      `);
      await db.execute(sql`ANALYZE case_law_index_jobs`);
      await db.execute(sql`ANALYZE case_law_decisions`);
      await db.execute(sql`ANALYZE eu_completion_receipts`);
      await db.transaction(async (tx) => {
        const query = buildEuCompletionPageQuery(tx, {
          ...state.options,
          after: null,
          limit: 100,
        });
        const page = await query;
        expect(page).toHaveLength(100);
        expect(page.every((row) => !row.eligible)).toBe(true);
        const plan = explainRoot(
          await tx.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.getSQL()}`,
          ),
        );
        expect(plan["Actual Rows"]).toBe(100);
        const scans = scanOccurrences(plan).filter(
          ({ relation }) =>
            relation === "case_law_decisions" ||
            relation === "eu_completion_receipts" ||
            relation === "case_law_index_jobs",
        );
        expect(scans.length).toBeGreaterThan(0);
        expect(scans.every(({ nodeType }) => nodeType.includes("Index"))).toBe(
          true,
        );
        expect(
          scans.some(
            ({ index }) => index === "case_law_decisions_source_id_page_idx",
          ),
        ).toBe(true);
        expect(
          scans.some(
            ({ relation, index }) =>
              relation === "case_law_index_jobs" &&
              index === "case_law_index_jobs_decision_idx",
          ),
        ).toBe(true);
        const blocks = plan["Shared Hit Blocks"];
        if (typeof blocks !== "number") {
          throw new TypeError("Expected EXPLAIN buffer count");
        }
        expect(blocks).toBeLessThan(5000);
      });
    }, 60_000);
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
