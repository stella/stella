import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
  softLawIngestionAttempts,
  softLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { softLawContentHash } from "@/api/lib/legal-search/soft-law-fingerprint";
import {
  SOFT_LAW_BATCH_LIMIT,
  SoftLawIngestionError,
} from "@/api/lib/legal-search/soft-law-types";
import type { SoftLawSourceAdapter } from "@/api/lib/legal-search/soft-law-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  adapter,
  document,
  entry,
  withSource,
} from "@/api/tests/soft-law-ingestion-support";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ORIGINAL_BYTES = "Original numbered guidance bytes";
const CANDIDATE_BYTES = "Changed numbered guidance candidate bytes";
const winner = () =>
  entry("https://uoou.gov.cz/original", "Original guidance", "02/2024");
const candidate = () =>
  entry("https://uoou.gov.cz/candidate", "Changed guidance", "02/2024");

type ReadCorpusOptions = { db: GatedTestDb; sourceId: SafeId<"softLawSource"> };
const readCorpus = async ({ db, sourceId }: ReadCorpusOptions) => {
  const [documents, versions, locators, attempts] = await Promise.all([
    db
      .select()
      .from(softLawDocuments)
      .where(eq(softLawDocuments.sourceId, sourceId)),
    db
      .select({ version: softLawDocumentVersions })
      .from(softLawDocumentVersions)
      .innerJoin(
        softLawDocuments,
        eq(softLawDocumentVersions.documentId, softLawDocuments.id),
      )
      .where(eq(softLawDocuments.sourceId, sourceId))
      .orderBy(
        softLawDocumentVersions.documentId,
        softLawDocumentVersions.sequence,
      ),
    db
      .select()
      .from(softLawDocumentLocators)
      .where(eq(softLawDocumentLocators.sourceId, sourceId)),
    db
      .select()
      .from(softLawIngestionAttempts)
      .where(eq(softLawIngestionAttempts.sourceId, sourceId)),
  ]);
  return {
    documents,
    versions: versions.map((row) => row.version),
    locators,
    attempts,
  };
};
type Corpus = Awaited<ReturnType<typeof readCorpus>>;
type AssertWinnerOptions = { before: Corpus; after: Corpus };
const assertWinnerPreserved = ({ before, after }: AssertWinnerOptions) => {
  expect(after.documents).toHaveLength(1);
  const original = before.documents.at(0) ?? panic("Initial winner missing");
  const actual = after.documents.at(0) ?? panic("Winner document was lost");
  expect(actual).toEqual({
    ...original,
    lastSeenAt: actual.lastSeenAt,
    lastSeenRun: actual.lastSeenRun,
  });
  expect(after.versions).toEqual(before.versions);
  expect(after.versions).toHaveLength(1);
  expect(after.locators).toHaveLength(1);
  const originalLocator =
    before.locators.at(0) ?? panic("Initial winner locator missing");
  const actualLocator =
    after.locators.at(0) ?? panic("Winner locator was lost");
  expect(actualLocator).toEqual({
    ...originalLocator,
    lastSeenAt: actualLocator.lastSeenAt,
    lastSeenRun: actualLocator.lastSeenRun,
  });
  expect(actualLocator.state).toBe("current");
  expect(actualLocator.url).toBe(winner().url);
};

const deferredCandidate = (corpus: Corpus) => {
  const deferred = corpus.attempts.find(
    (attempt) =>
      attempt.url === candidate().url && attempt.status === "deferred",
  );
  if (!deferred?.observation) {
    panic("Candidate was not captured durably before the walk completed");
  }
  expect(deferred).toMatchObject({
    status: "deferred",
    tag: null,
    identityKey: null,
    count: 1,
  });
  expect(deferred.observation.entry).toEqual(candidate());
  expect(deferred.observation.input).toEqual({
    metadata: candidate().metadata,
    text: CANDIDATE_BYTES,
    extractionQuality: "html",
    sourceDates: {},
  });
  expect(Object.hasOwn(deferred.observation.input, "raw")).toBe(false);
  expect(deferred.observation.contentHash).toBe(
    softLawContentHash(document(candidate(), CANDIDATE_BYTES)),
  );
  return deferred;
};

if (!databaseUrl || !enabled) {
  describe.skip("guidance walk decisions on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("a numbered winner listed anywhere in the complete walk defeats a changed candidate", () => {
    for (const layout of ["same-page", "separate-pages"] as const) {
      for (const order of ["candidate-first", "winner-first"] as const) {
        test(`${layout} ${order} preserves the winner through complete-walk replays`, async () =>
          await withSource(databaseUrl, async ({ db, sourceId, run }) => {
            expect(await run(adapter([winner()], ORIGINAL_BYTES))).toEqual({
              status: "complete",
            });
            const before = await readCorpus({ db, sourceId });
            const entries =
              order === "candidate-first"
                ? [candidate(), winner()]
                : [winner(), candidate()];
            const sourceAdapter = {
              ...adapter(entries),
              discover: async ({ cursor }) => {
                if (layout === "same-page") {
                  return { entries, nextCursor: null };
                }
                if (cursor === null) {
                  return {
                    entries: entries.slice(0, 1),
                    nextCursor: "second-page",
                  };
                }
                return { entries: entries.slice(1), nextCursor: null };
              },
              fetchDocument: async (item) =>
                Result.ok(
                  document(
                    item,
                    item.url === candidate().url
                      ? CANDIDATE_BYTES
                      : ORIGINAL_BYTES,
                  ),
                ),
            } as const satisfies SoftLawSourceAdapter;
            for (let replay = 0; replay < 2; replay++) {
              expect(await run(sourceAdapter)).toEqual({ status: "complete" });
              const after = await readCorpus({ db, sourceId });
              assertWinnerPreserved({ before, after });
              expect(
                after.attempts.some(
                  (attempt) =>
                    attempt.url === candidate().url &&
                    attempt.status === "rejected" &&
                    attempt.tag === "identity_collision",
                ),
              ).toBe(true);
              expect(
                after.attempts.some((attempt) => attempt.status === "deferred"),
              ).toBe(false);
            }
          }));
      }
    }
  });

  describe("changed numbered locators wait for durable complete-walk evidence", () => {
    test("a genuine move promotes the captured candidate only after the old winner is absent from a completed walk", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([winner()], ORIGINAL_BYTES))).toEqual({
          status: "complete",
        });
        const before = await readCorpus({ db, sourceId });
        let inspectedDeferred = false;
        let candidateFetches = 0;
        const sourceAdapter = {
          ...adapter([candidate()]),
          discover: async ({ cursor }) => {
            if (cursor === null) {
              return { entries: [candidate()], nextCursor: "finish-walk" };
            }
            const pending = await readCorpus({ db, sourceId });
            assertWinnerPreserved({ before, after: pending });
            const deferred = deferredCandidate(pending);
            expect(deferred.observation?.documentId).toBe(
              before.documents.at(0)?.id,
            );
            inspectedDeferred = true;
            return { entries: [], nextCursor: null };
          },
          fetchDocument: async (item) => {
            candidateFetches++;
            return Result.ok(document(item, CANDIDATE_BYTES));
          },
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(inspectedDeferred).toBe(true);
        expect(candidateFetches).toBe(1);
        const after = await readCorpus({ db, sourceId });
        expect(after.documents).toHaveLength(1);
        expect(after.documents.at(0)).toMatchObject({
          id: before.documents.at(0)?.id,
          title: candidate().metadata.title,
          listingState: "listed",
        });
        expect(after.versions).toHaveLength(2);
        expect(after.versions.at(0)).toEqual({
          ...before.versions.at(0),
          observedTo: after.versions.at(1)?.observedFrom,
        });
        expect(after.versions.at(1)).toMatchObject({
          sequence: 2,
          observedTo: null,
          extractedText: CANDIDATE_BYTES,
          metadata: candidate().metadata,
        });
        expect(
          after.locators
            .filter((locator) => locator.state === "current")
            .map((locator) => locator.url),
        ).toEqual([candidate().url]);
        expect(
          after.locators
            .filter((locator) => locator.state === "historical")
            .map((locator) => locator.url),
        ).toEqual([winner().url]);
        expect(
          after.attempts.some(
            (attempt) =>
              attempt.url === candidate().url && attempt.status === "applied",
          ),
        ).toBe(true);
        expect(
          after.attempts.some((attempt) => attempt.status === "deferred"),
        ).toBe(false);
      }));

    test("a failed walk resumes its deferred snapshot without fetching or writing candidate raw data again", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([winner()], ORIGINAL_BYTES))).toEqual({
          status: "complete",
        });
        const before = await readCorpus({ db, sourceId });
        let candidateFetches = 0;
        const written: string[] = [];
        const cursors: (string | null)[] = [];
        const writeRaw: WriteRawSourcePayload = async (options) => {
          const key = rawSourcePayloadKey(options);
          written.push(key);
          return key;
        };
        const makeWalk = (interrupted: boolean) =>
          ({
            ...adapter([candidate(), winner()]),
            discover: async ({ cursor }) => {
              cursors.push(cursor);
              if (cursor === null) {
                return { entries: [candidate()], nextCursor: "winner-page" };
              }
              if (interrupted) {
                return await Promise.reject(
                  new SoftLawIngestionError({
                    message:
                      "Discovery interrupted after the durable candidate page",
                  }),
                );
              }
              return { entries: [winner()], nextCursor: null };
            },
            fetchDocument: async (item) => {
              if (item.url === candidate().url) {
                candidateFetches++;
              }
              return Result.ok(
                document(
                  item,
                  item.url === candidate().url
                    ? CANDIDATE_BYTES
                    : ORIGINAL_BYTES,
                ),
              );
            },
          }) as const satisfies SoftLawSourceAdapter;
        const interrupted = await run(makeWalk(true), { writeRaw });
        expect(interrupted.status).toBe("failed");
        if (interrupted.status !== "failed") {
          panic("Interrupted discovery unexpectedly completed");
        }
        expect(interrupted.error).toBeInstanceOf(SoftLawIngestionError);
        expect(interrupted.error).toMatchObject({
          message: "Discovery interrupted after the durable candidate page",
        });
        const pending = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after: pending });
        const deferred = deferredCandidate(pending);
        const snapshot =
          deferred.observation ?? panic("Deferred snapshot missing");
        expect(snapshot.documentId).toBe(before.documents.at(0)?.id);
        expect(snapshot.identityKey).toBe(before.documents.at(0)?.identityKey);
        expect(snapshot.rawObjects).toEqual([
          { role: "document", key: written.at(0), contentType: "text/html" },
        ]);
        expect(written).toHaveLength(1);
        const candidateKey =
          written.at(0) ?? panic("Candidate raw object was not written");
        const heldSource = (
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId))
        ).at(0);
        expect(heldSource).toMatchObject({
          runState: "failed",
          syncCursor: "winner-page",
        });
        expect(heldSource?.runId).toBe(deferred.runId);
        expect(await run(makeWalk(false), { writeRaw })).toEqual({
          status: "complete",
        });
        const after = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after });
        expect(candidateFetches).toBe(1);
        expect(written.filter((key) => key === candidateKey)).toHaveLength(1);
        expect(cursors).toEqual([null, "winner-page", "winner-page"]);
        expect(
          after.attempts.find((attempt) => attempt.id === deferred.id),
        ).toMatchObject({
          status: "rejected",
          tag: "identity_collision",
          count: 1,
        });
      }));

    test("deciding-phase failure resumes durable decisions without repeating any external work", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([winner()], ORIGINAL_BYTES))).toEqual({
          status: "complete",
        });
        const before = await readCorpus({ db, sourceId });
        const calls = { discover: 0, count: 0, fetch: 0, raw: 0 };
        const sourceAdapter = {
          ...adapter([candidate(), winner()]),
          getTotalCount: async () => {
            calls.count++;
            return { type: "no-count-endpoint" };
          },
          discover: async ({ cursor }) => {
            calls.discover++;
            if (cursor === null) {
              return { entries: [candidate()], nextCursor: "winner-page" };
            }
            return { entries: [winner()], nextCursor: null };
          },
          fetchDocument: async (item) => {
            calls.fetch++;
            return Result.ok(
              document(
                item,
                item.url === candidate().url ? CANDIDATE_BYTES : ORIGINAL_BYTES,
              ),
            );
          },
        } as const satisfies SoftLawSourceAdapter;
        const writeRaw: WriteRawSourcePayload = async (options) => {
          calls.raw++;
          return rawSourcePayloadKey(options);
        };
        const injectedError = new SoftLawIngestionError({
          message:
            "Decision transaction interrupted before applying durable observations",
        });
        let faultEnabled = true;
        let decidingObserved = false;
        const scopedDb: ScopedDb = async (work) => {
          const source = (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0);
          if (faultEnabled && source?.runState === "deciding") {
            decidingObserved = true;
            faultEnabled = false;
            return await Promise.reject(injectedError);
          }
          return await db.transaction(work);
        };
        const interrupted = await run(sourceAdapter, { scopedDb, writeRaw });
        expect(interrupted.status).toBe("failed");
        if (interrupted.status !== "failed") {
          panic("Interrupted decision unexpectedly completed");
        }
        expect(interrupted.error).toBeInstanceOf(SoftLawIngestionError);
        expect(interrupted.error).toMatchObject({
          message: "Guidance persistence failed",
        });
        if (!(interrupted.error instanceof SoftLawIngestionError)) {
          panic("Decision failure lost its typed persistence error");
        }
        expect(interrupted.error.cause).toBe(injectedError);
        expect(decidingObserved).toBe(true);
        const pending = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after: pending });
        const deferred = deferredCandidate(pending);
        const heldSource = (
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId))
        ).at(0);
        expect(heldSource).toMatchObject({
          runState: "deciding",
          syncCursor: null,
          runId: deferred.runId,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        const callsBeforeRecovery = { ...calls };
        faultEnabled = false;
        expect(await run(sourceAdapter, { scopedDb, writeRaw })).toEqual({
          status: "complete",
        });
        expect(calls).toEqual(callsBeforeRecovery);
        const after = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after });
        expect(
          after.attempts.find((attempt) => attempt.id === deferred.id),
        ).toMatchObject({
          status: "rejected",
          tag: "identity_collision",
          count: 1,
        });
        expect(
          after.attempts.some((attempt) => attempt.status === "deferred"),
        ).toBe(false);
      }));

    test("decision batches commit at most the batch limit and recover the remaining receipt atomically", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([winner()], ORIGINAL_BYTES))).toEqual({
          status: "complete",
        });
        const before = await readCorpus({ db, sourceId });
        const candidates = Array.from(
          { length: SOFT_LAW_BATCH_LIMIT + 1 },
          (_, index) =>
            entry(
              `https://uoou.gov.cz/candidate-${String(index).padStart(3, "0")}`,
              `Changed guidance ${index}`,
              "02/2024",
            ),
        );
        const calls = { discover: 0, count: 0, fetch: 0, raw: 0 };
        const sourceAdapter = {
          ...adapter(candidates),
          getTotalCount: async () => {
            calls.count++;
            return { type: "no-count-endpoint" };
          },
          discover: async ({ cursor }) => {
            calls.discover++;
            if (cursor === null) {
              return {
                entries: candidates.slice(0, SOFT_LAW_BATCH_LIMIT),
                nextCursor: "last-candidate",
              };
            }
            if (cursor === "last-candidate") {
              return {
                entries: candidates.slice(SOFT_LAW_BATCH_LIMIT),
                nextCursor: "winner-page",
              };
            }
            return { entries: [winner()], nextCursor: null };
          },
          fetchDocument: async (item) => {
            calls.fetch++;
            return Result.ok(
              document(
                item,
                item.url === winner().url
                  ? ORIGINAL_BYTES
                  : `Changed body at ${item.url}`,
              ),
            );
          },
        } as const satisfies SoftLawSourceAdapter;
        const writeRaw: WriteRawSourcePayload = async (options) => {
          calls.raw++;
          return rawSourcePayloadKey(options);
        };
        let decisionTransactions = 0;
        let faultEnabled = true;
        const injectedError = new SoftLawIngestionError({
          message: "Second decision batch interrupted before its transaction",
        });
        const scopedDb: ScopedDb = async (work) => {
          const source = (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0);
          if (faultEnabled && source?.runState === "deciding") {
            decisionTransactions++;
            if (decisionTransactions === 2) {
              faultEnabled = false;
              return await Promise.reject(injectedError);
            }
          }
          return await db.transaction(work);
        };
        const interrupted = await run(sourceAdapter, { scopedDb, writeRaw });
        expect(interrupted.status).toBe("failed");
        if (interrupted.status !== "failed") {
          panic("Interrupted bounded decision unexpectedly completed");
        }
        expect(interrupted.error).toBeInstanceOf(SoftLawIngestionError);
        expect(interrupted.error).toMatchObject({
          message: "Guidance persistence failed",
        });
        if (!(interrupted.error instanceof SoftLawIngestionError)) {
          panic("Bounded decision failure lost its typed persistence error");
        }
        expect(interrupted.error.cause).toBe(injectedError);
        expect(decisionTransactions).toBe(2);
        const pending = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after: pending });
        const remaining = pending.attempts.filter(
          (attempt) => attempt.status === "deferred",
        );
        expect(remaining).toHaveLength(1);
        const deferred =
          remaining.at(0) ?? panic("Final candidate snapshot missing");
        expect(deferred).toMatchObject({
          url: candidates.at(-1)?.url,
          count: 1,
          tag: null,
        });
        expect(deferred.observation?.rawObjects).toHaveLength(1);
        const currentReceipts = pending.attempts.filter(
          (attempt) => attempt.runId === deferred.runId,
        );
        expect(currentReceipts).toHaveLength(SOFT_LAW_BATCH_LIMIT + 2);
        expect(
          currentReceipts.filter(
            (attempt) =>
              attempt.status === "rejected" &&
              attempt.tag === "identity_collision",
          ),
        ).toHaveLength(SOFT_LAW_BATCH_LIMIT);
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0),
        ).toMatchObject({
          runState: "deciding",
          runId: deferred.runId,
          syncCursor: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        const callsBeforeRecovery = { ...calls };
        expect(await run(sourceAdapter, { scopedDb, writeRaw })).toEqual({
          status: "complete",
        });
        expect(calls).toEqual(callsBeforeRecovery);
        const after = await readCorpus({ db, sourceId });
        assertWinnerPreserved({ before, after });
        const finalReceipts = after.attempts.filter(
          (attempt) => attempt.runId === deferred.runId,
        );
        expect(finalReceipts).toHaveLength(SOFT_LAW_BATCH_LIMIT + 2);
        expect(
          finalReceipts.filter(
            (attempt) =>
              attempt.status === "rejected" &&
              attempt.tag === "identity_collision",
          ),
        ).toHaveLength(SOFT_LAW_BATCH_LIMIT + 1);
        expect(
          finalReceipts.find((attempt) => attempt.id === deferred.id),
        ).toMatchObject({
          status: "rejected",
          tag: "identity_collision",
          count: 1,
        });
        expect(
          finalReceipts.some((attempt) => attempt.status === "deferred"),
        ).toBe(false);
      }));

    test("an incomplete two-of-three walk cannot promote its deferred candidate or remove the unseen winner", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const filler = entry(
          "https://uoou.gov.cz/filler",
          "Filler guidance",
          "03/2024",
        );
        const unseen = entry(
          "https://uoou.gov.cz/unseen",
          "Unseen guidance",
          "04/2024",
        );
        expect(
          await run(adapter([winner(), filler, unseen], ORIGINAL_BYTES)),
        ).toEqual({ status: "complete" });
        const before = await readCorpus({ db, sourceId });
        const sourceAdapter = {
          ...adapter([candidate(), filler]),
          fetchDocument: async (item) =>
            Result.ok(
              document(
                item,
                item.url === candidate().url ? CANDIDATE_BYTES : ORIGINAL_BYTES,
              ),
            ),
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toMatchObject({
          status: "listing_incomplete",
          seen: 2,
          baseline: 3,
        });
        const after = await readCorpus({ db, sourceId });
        expect(after.documents.map((row) => row.id).toSorted()).toEqual(
          before.documents.map((row) => row.id).toSorted(),
        );
        expect(
          after.documents.every((row) => row.listingState === "listed"),
        ).toBe(true);
        expect(after.locators).toHaveLength(3);
        expect(
          after.locators.every((locator) => locator.state === "current"),
        ).toBe(true);
        expect(
          after.locators.some((locator) => locator.url === candidate().url),
        ).toBe(false);
        expect(after.versions).toEqual(before.versions);
        const oldWinner =
          before.documents.find(
            (row) => row.title === winner().metadata.title,
          ) ?? panic("Original winner missing");
        expect(after.documents.find((row) => row.id === oldWinner.id)).toEqual(
          oldWinner,
        );
        expect(deferredCandidate(after).observation?.documentId).toBe(
          oldWinner.id,
        );
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0),
        ).toMatchObject({
          runState: "listing_incomplete",
          listingBaseline: 3,
          listingSeen: 2,
        });
      }));
  });
}
