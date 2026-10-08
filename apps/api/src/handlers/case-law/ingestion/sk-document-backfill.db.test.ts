/**
 * The backfill's risk is its queue query, not its parsing: it decides
 * which rows are still waiting and in what order, and a wrong predicate
 * either loops on the same decisions forever, silently skips the
 * backlog, or leaves the decisions readers are waiting on at the back.
 * That is SQL, so it is tested against Postgres.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */

import { PDF } from "@libpdf/core";
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import {
  claimDocumentFetch,
  DOCUMENT_FETCH_FAILURE,
  fetchDecisionDocument,
  hasPendingDeferredDocumentsForSource,
  loadPendingDocuments,
  loadRequestedDocuments,
  loadRemainingDocuments,
  markDocumentUnavailable,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
  MAX_DOCUMENT_PDF_BYTES,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  recordDocumentFetchRequest,
  storeBackfilledDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";
import { SkDocumentNonPdfError } from "@/api/lib/legal-search/sk-document-fetch-diagnostics";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { readOfResponse } from "@/api/tests/helpers/publisher-read";

/**
 * Wide enough to hold the whole queue on the migrated-but-unseeded
 * database this suite runs against, so an ordering assertion sees every
 * row it created.
 */
const QUEUE_READ_LIMIT = 500;

/**
 * Keep only the decisions a test created, in the order the queue
 * returned them, so rows left by neighbouring tests cannot change the
 * assertion.
 */
const onlyThese = (
  queue: readonly PendingDocument[],
  ids: readonly SafeId<"caseLawDecision">[],
): SafeId<"caseLawDecision">[] => {
  const wanted = new Set<string>(ids);

  return queue.map((row) => row.id).filter((id) => wanted.has(id));
};

/**
 * What the promise rejected with; a resolution comes back wrapped so it can
 * never pass for the expected error. bun-types declares `.rejects.toX` as
 * void, so awaiting it trips type-aware lint; capture the rejection instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const parsedAst: DocumentAst = {
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "backfill",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/1/2026",
    ecli: null,
    court: "Okresný súd",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "b1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      plainText: "Rozsudok",
      inlines: [{ type: "text", text: "Rozsudok" }],
    },
  ],
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("sk-courts document backfill", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("sk-courts document backfill", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const probeSources: SafeId<"caseLawSource">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (values: {
      caseNumber: string;
      fulltext: string | null;
      documentUrl: string | null;
      decisionDate?: string;
      documentFetchRequestedAt?: Date;
      documentFetchAttemptedAt?: Date;
      documentFetchAttempts?: number;
      sourceHash?: string;
      contentHash?: string;
      corpusMirrorStatus?:
        | typeof CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
        | typeof CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED;
      sourceObservationHash?: string;
      sourceObservationOrder?: bigint;
      sourceId?: SafeId<"caseLawSource">;
    }) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId: values.sourceId ?? sourceId,
          caseNumber: values.caseNumber,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          fulltext: values.fulltext,
          documentUrl: values.documentUrl,
          decisionDate: values.decisionDate,
          documentFetchRequestedAt: values.documentFetchRequestedAt,
          documentFetchAttemptedAt: values.documentFetchAttemptedAt,
          documentFetchAttempts: values.documentFetchAttempts,
          sourceHash: values.sourceHash,
          contentHash: values.contentHash,
          corpusMirrorStatus: values.corpusMirrorStatus,
          sourceObservationHash: values.sourceObservationHash,
          sourceObservationOrder: values.sourceObservationOrder,
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    const claimFor = async (id: SafeId<"caseLawDecision">) => {
      const claim = await claimDocumentFetch(id, scopedDb);
      expect(claim.status).toBe("claimed");
      if (claim.status !== "claimed") {
        throw new Error("expected claimed snapshot");
      }
      return claim.decision;
    };

    const readFetchState = async (id: SafeId<"caseLawDecision">) =>
      await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: {
          documentFetchRequestedAt: true,
          documentFetchAttemptedAt: true,
          documentFetchAttempts: true,
        },
      });

    beforeAll(async () => {
      // The queue resolves its source by adapter key, so the source must
      // carry the real one. Reuse an existing row rather than inserting
      // a duplicate: `adapter_key` is unique.
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          name: "SK courts backfill test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
    });

    cleanUp(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
      if (probeSources.length > 0) {
        await db
          .delete(caseLawSources)
          .where(inArray(caseLawSources.id, probeSources));
      }
    });

    test("backlog presence includes cooled-down and parked decisions", async () => {
      const [probeSource] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: `sk-document-probe-${suffix}`,
          name: "SK document backlog probe",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!probeSource) {
        throw new Error("expected probe source row");
      }
      probeSources.push(probeSource.id);

      await insertDecision({
        sourceId: probeSource.id,
        caseNumber: `filled-probe-${suffix}`,
        fulltext: "already parsed",
        documentUrl: "https://example.test/filled-probe.pdf",
      });
      await insertDecision({
        sourceId: probeSource.id,
        caseNumber: `url-less-probe-${suffix}`,
        fulltext: null,
        documentUrl: null,
      });
      expect(
        await hasPendingDeferredDocumentsForSource({
          scopedDb,
          sourceId: probeSource.id,
        }),
      ).toBe(false);

      await insertDecision({
        sourceId: probeSource.id,
        caseNumber: `cooled-backlog-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/cooled-backlog.pdf",
        documentFetchAttemptedAt: new Date(),
        documentFetchAttempts: 1,
      });
      await insertDecision({
        sourceId: probeSource.id,
        caseNumber: `parked-backlog-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/parked-backlog.pdf",
        documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS,
      });

      expect(
        await loadRequestedDocuments({
          scopedDb,
          sourceId: probeSource.id,
          limit: 1,
        }),
      ).toEqual([]);
      expect(
        await loadRemainingDocuments({
          scopedDb,
          sourceId: probeSource.id,
          limit: 1,
        }),
      ).toEqual([]);
      expect(
        await hasPendingDeferredDocumentsForSource({
          scopedDb,
          sourceId: probeSource.id,
        }),
      ).toBe(true);
    });

    test("queues only decisions that are still waiting on a document", async () => {
      const waiting = await insertDecision({
        caseNumber: `waiting-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/waiting.pdf",
      });
      await insertDecision({
        caseNumber: `done-${suffix}`,
        fulltext: "already parsed",
        documentUrl: "https://example.test/done.pdf",
      });
      // Marked unavailable by an earlier run: empty, not null.
      await insertDecision({
        caseNumber: `unavailable-${suffix}`,
        fulltext: "",
        documentUrl: "https://example.test/gone.pdf",
      });
      // Nothing to fetch, so it can never leave the queue.
      await insertDecision({
        caseNumber: `no-url-${suffix}`,
        fulltext: null,
        documentUrl: null,
      });

      const pending = await loadPendingDocuments(scopedDb, 100);
      const ids = pending.map((row) => row.id);

      expect(ids).toContain(waiting);
      expect(pending.filter((row) => created.includes(row.id))).toHaveLength(1);
    });

    test("a stored document leaves the queue with text, AST and sections", async () => {
      const id = await insertDecision({
        caseNumber: `store-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/store.pdf",
      });

      await storeBackfilledDocument({
        decision: await claimFor(id),
        document: {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [
            { index: 0, type: "header", title: null, text: "Rozsudok" },
          ],
        },
        scopedDb,
      });

      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: {
          fulltext: true,
          documentAst: true,
          sections: true,
          parserVersion: true,
        },
      });

      expect(row?.fulltext).toContain("Odôvodnenie");
      expect(row?.sections).toHaveLength(1);
      expect(row?.parserVersion).toBe(PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS]);
      expect(
        row?.documentAst && "blocks" in row.documentAst
          ? row.documentAst.blocks.length
          : 0,
      ).toBe(1);

      const stillPending = await loadPendingDocuments(scopedDb, 100);
      expect(stillPending.map((pending) => pending.id)).not.toContain(id);
    });

    test("an unparseable document leaves the queue rather than repeating", async () => {
      const id = await insertDecision({
        caseNumber: `bad-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/bad.pdf",
      });

      await markDocumentUnavailable({
        decision: await claimFor(id),
        scopedDb,
      });

      const pending = await loadPendingDocuments(scopedDb, 100);
      expect(pending.map((row) => row.id)).not.toContain(id);

      const [row] = await db
        .select({ fulltext: caseLawDecisions.fulltext })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.id, id),
            eq(caseLawDecisions.sourceId, sourceId),
          ),
        );
      expect(row?.fulltext).toBe("");
    });

    test("marking unavailable invalidates pending corpus ownership", async () => {
      const id = await insertDecision({
        caseNumber: `unavailable-pending-${suffix}`,
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        fulltext: null,
        documentUrl: "https://example.test/unavailable-pending.pdf",
        sourceObservationHash: "pending-hash",
        sourceObservationOrder: 7n,
      });

      await markDocumentUnavailable({
        decision: await claimFor(id),
        scopedDb,
      });

      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: { corpusMirrorStatus: true, fulltext: true },
      });
      expect(row).toEqual({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        fulltext: "",
      });
    });

    test("a second store cannot overwrite the document already there", async () => {
      const id = await insertDecision({
        caseNumber: `converge-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/converge.pdf",
      });
      const stored = {
        fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
        documentAst: parsedAst,
        sections: [],
      };

      const decision = await claimFor(id);
      await storeBackfilledDocument({
        decision,
        document: stored,
        scopedDb,
      });
      // A second fetch of the same decision — the queue and a reader can
      // both reach it — must converge rather than replace what is there.
      await storeBackfilledDocument({
        decision,
        document: { ...stored, fulltext: "Stale re-parse." },
        scopedDb,
      });

      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: { fulltext: true },
      });

      expect(row?.fulltext).toBe(stored.fulltext);
    });

    test("a fetch that came back empty cannot erase a stored document", async () => {
      const id = await insertDecision({
        caseNumber: `no-erase-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/no-erase.pdf",
      });

      const decision = await claimFor(id);
      await storeBackfilledDocument({
        decision,
        document: {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [],
        },
        scopedDb,
      });
      await markDocumentUnavailable({
        decision,
        scopedDb,
      });

      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: { fulltext: true },
      });

      expect(row?.fulltext).toContain("Odôvodnenie");
    });

    test("only the first reader's request is kept", async () => {
      const id = await insertDecision({
        caseNumber: `request-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/request.pdf",
      });

      await recordDocumentFetchRequest(id, scopedDb);
      const firstRequest = await readFetchState(id);
      await recordDocumentFetchRequest(id, scopedDb);
      const afterRepeat = await readFetchState(id);

      // A second reader must not push the decision back down its tier.
      expect(afterRepeat?.documentFetchRequestedAt).toEqual(
        firstRequest?.documentFetchRequestedAt ?? null,
      );
    });

    test("one claim at a time; the loser skips instead of downloading", async () => {
      const id = await insertDecision({
        caseNumber: `claim-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/claim.pdf",
      });

      // A reader on one replica and the scheduler on another reach the
      // same decision: exactly one may fetch it.
      expect((await claimDocumentFetch(id, scopedDb)).status).toBe("claimed");
      expect((await claimDocumentFetch(id, scopedDb)).status).toBe("held");

      const afterClaims = await readFetchState(id);
      expect(afterClaims?.documentFetchAttempts).toBe(1);
      expect(afterClaims?.documentFetchAttemptedAt).not.toBeNull();
    });

    test("a claim from a worker that died is reclaimable", async () => {
      const id = await insertDecision({
        caseNumber: `claim-stale-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/claim-stale.pdf",
        documentFetchAttemptedAt: new Date(Date.now() - 60 * 60 * 1000),
        documentFetchAttempts: 1,
      });

      expect((await claimDocumentFetch(id, scopedDb)).status).toBe("claimed");
      expect((await readFetchState(id))?.documentFetchAttempts).toBe(2);
    });

    test("a decision that already has its document cannot be claimed", async () => {
      const id = await insertDecision({
        caseNumber: `claim-filled-${suffix}`,
        fulltext: "already parsed",
        documentUrl: "https://example.test/claim-filled.pdf",
      });

      expect((await claimDocumentFetch(id, scopedDb)).status).toBe("held");
    });

    test("a trimmed decision is not queued for a fetch it already had", async () => {
      // Canonical storage plus the column trim: the text column is NULL
      // by design and object storage holds the document. Reading NULL as
      // "never fetched" would put the whole drained corpus back in the
      // queue.
      const trimmed = await insertDecision({
        caseNumber: `trimmed-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/trimmed.pdf",
        contentHash: "a-real-content-hash",
      });
      // Written before its document existed: the objects are the empty
      // shapes, so this one is still waiting.
      const emptyObjects = await insertDecision({
        caseNumber: `empty-objects-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/empty-objects.pdf",
        contentHash: EMPTY_CORPUS_CONTENT_HASHES.at(0) ?? "",
      });

      const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);

      expect(onlyThese(queue, [trimmed, emptyObjects])).toEqual([emptyObjects]);
    });

    test("the store applies only while the claimed source hash holds", async () => {
      const id = await insertDecision({
        caseNumber: `pin-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/pin.pdf",
        sourceHash: "hash-at-claim",
      });
      const document = {
        fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
        documentAst: parsedAst,
        sections: [],
      };

      const decision = await claimFor(id);

      // The source refreshed the decision while the document was being
      // fetched, so what was parsed describes a row that no longer
      // exists in that form.
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: "hash-after-refresh" })
        .where(eq(caseLawDecisions.id, id));

      await storeBackfilledDocument({
        decision,
        document,
        scopedDb,
      });

      expect(
        (
          await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { fulltext: true },
          })
        )?.fulltext,
      ).toBeNull();

      await db
        .update(caseLawDecisions)
        .set({
          documentFetchAttemptedAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        .where(eq(caseLawDecisions.id, id));

      // Fetched again against the row as it now stands, the same
      // document stores.
      await storeBackfilledDocument({
        decision: await claimFor(id),
        document,
        scopedDb,
      });

      expect(
        (
          await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { fulltext: true },
          })
        )?.fulltext,
      ).toContain("Odôvodnenie");
    });

    test("the claim carries the source hash the store has to pin", async () => {
      const id = await insertDecision({
        caseNumber: `claim-hash-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/claim-hash.pdf",
        sourceHash: "hash-at-claim",
      });

      const claim = await claimDocumentFetch(id, scopedDb);

      expect(claim.status).toBe("claimed");
      if (claim.status !== "claimed") {
        throw new Error("expected claimed snapshot");
      }
      expect(claim.decision).toMatchObject({
        id,
        sourceHash: "hash-at-claim",
        documentUrl: "https://example.test/claim-hash.pdf",
      });
      expect(claim.attempts).toBe(1);
    });

    test("a run just attempted is left alone until its cooldown passes", async () => {
      const cooling = await insertDecision({
        caseNumber: `cooldown-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/cooldown.pdf",
        decisionDate: "2026-03-02",
        documentFetchAttemptedAt: new Date(),
        documentFetchAttempts: 1,
      });
      // Same decision date range, but attempted long enough ago.
      const cooled = await insertDecision({
        caseNumber: `cooled-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/cooled.pdf",
        decisionDate: "2026-03-01",
        documentFetchAttemptedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        documentFetchAttempts: 1,
      });

      const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);

      expect(onlyThese(queue, [cooling, cooled])).toEqual([cooled]);
    });

    test("a refused decision comes back once its cooldown passes", async () => {
      // What bounds a source answering 403 for the newest page is the
      // cooldown, not the order: each refusal costs one attempt per
      // cooldown. Ordering by attempts on top of that did not bound
      // anything further, it only pushed the retry behind the backlog.
      const refusedIds = await Promise.all(
        [1, 2, 3].map(
          async (n) =>
            await insertDecision({
              caseNumber: `retry-refused-${n}-${suffix}`,
              fulltext: null,
              documentUrl: `https://example.test/refused-${n}.pdf`,
              // Newest decisions, so date order puts them first.
              decisionDate: `2026-08-0${n}`,
              documentFetchAttempts: MAX_PRIORITY_FETCH_ATTEMPTS,
              // Past the longest cooldown, which grows with attempts.
              documentFetchAttemptedAt: new Date(
                Date.now() - 5 * 24 * 60 * 60 * 1000,
              ),
            }),
        ),
      );
      const untried = await insertDecision({
        caseNumber: `retry-untried-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/untried.pdf",
        decisionDate: "2026-01-01",
      });

      const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);

      // Newest first, whatever each has already cost: the cooled
      // refusals, then the older untried decision.
      expect(onlyThese(queue, [...refusedIds, untried])).toEqual([
        ...refusedIds.toReversed(),
        untried,
      ]);
    });

    test("requested decisions come first, then the newest of the rest", async () => {
      const requestedLater = await insertDecision({
        caseNumber: `priority-requested-late-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/requested-late.pdf",
        decisionDate: "2020-01-01",
        documentFetchRequestedAt: new Date("2026-07-20T10:00:00.000Z"),
      });
      const requestedFirst = await insertDecision({
        caseNumber: `priority-requested-early-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/requested-early.pdf",
        decisionDate: "2019-01-01",
        documentFetchRequestedAt: new Date("2026-07-19T10:00:00.000Z"),
      });
      const newest = await insertDecision({
        caseNumber: `priority-newest-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/newest.pdf",
        decisionDate: "2026-07-01",
      });
      const older = await insertDecision({
        caseNumber: `priority-older-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/older.pdf",
        decisionDate: "2026-06-01",
      });
      // Requested, but out of retries: back to the date-ordered tier.
      const exhausted = await insertDecision({
        caseNumber: `priority-exhausted-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/exhausted.pdf",
        decisionDate: "2026-05-01",
        documentFetchRequestedAt: new Date("2026-07-18T10:00:00.000Z"),
        documentFetchAttempts: MAX_PRIORITY_FETCH_ATTEMPTS,
      });

      const expected = [
        requestedFirst,
        requestedLater,
        newest,
        older,
        exhausted,
      ];
      const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);

      expect(onlyThese(queue, expected)).toEqual(expected);
    });

    test("a keyset cursor resumes after the decision it names", async () => {
      const first = await insertDecision({
        caseNumber: `cursor-first-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/cursor-first.pdf",
        decisionDate: "2026-04-02",
      });
      const second = await insertDecision({
        caseNumber: `cursor-second-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/cursor-second.pdf",
        decisionDate: "2026-04-01",
      });

      const page = await loadRemainingDocuments({
        scopedDb,
        sourceId,
        limit: QUEUE_READ_LIMIT,
        after: { decisionDate: "2026-04-02", id: first },
      });

      expect(onlyThese(page, [first, second])).toEqual([second]);
    });

    describe("one decision's failure", () => {
      const PUBLISHER_URL =
        "https://obcan.justice.sk/content/public/item/0b7e8a8e-2f55-4b5a-9d5e-2f3f6d1c0a11";

      const fetchWith = async (
        id: SafeId<"caseLawDecision">,
        answer: () => Promise<Response>,
      ) =>
        await fetchDecisionDocument({
          decisionId: id,
          fetchDocument: async () => readOfResponse(await answer()),
          scopedDb,
          signal: new AbortController().signal,
        });

      const insertPending = async (
        label: string,
        documentFetchAttempts = 0,
      ): Promise<SafeId<"caseLawDecision">> =>
        await insertDecision({
          caseNumber: `failure-${label}-${suffix}`,
          fulltext: null,
          documentUrl: PUBLISHER_URL,
          documentFetchAttempts,
        });

      test("buffered decisions use the claimed URL and metadata for every old response", async () => {
        const pdf = PDF.create();
        pdf
          .addPage({ size: "letter" })
          .drawText("Current decision text", { x: 72, y: 720, size: 12 });
        const bytes = await pdf.save();
        const oldPdf = PDF.create();
        oldPdf
          .addPage({ size: "letter" })
          .drawText("Old decision text", { x: 72, y: 720, size: 12 });
        const oldBytes = await oldPdf.save();
        const currentUrl = PUBLISHER_URL.replace("0b7e8a8e", "1b7e8a8e");
        for (const oldStatus of [200, 404]) {
          const label = `buffered-${oldStatus}`;
          const id = await insertDecision({
            caseNumber: `${label}-${suffix}`,
            fulltext: null,
            documentUrl: PUBLISHER_URL,
            sourceHash: "source-v1",
          });
          const buffered = await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
          });
          if (buffered === undefined) {
            throw new Error("expected buffered decision");
          }
          const metadata = {
            caseNumber: `current-${suffix}-${oldStatus}`,
            ecli: "ECLI:SK:OSBA1:2026:1234567890.1",
            court: "Current court",
            country: "SVK",
            decisionDate: "2026-06-01",
            decisionType: "ROZSUDOK",
          };
          await db
            .update(caseLawDecisions)
            .set({
              ...metadata,
              documentUrl: currentUrl,
              sourceHash: "source-v2",
            })
            .where(eq(caseLawDecisions.id, buffered.id));
          expect(buffered.documentUrl).not.toBe(currentUrl);
          expect(buffered.caseNumber).not.toBe(metadata.caseNumber);
          const urls: string[] = [];
          const outcome = await fetchDecisionDocument({
            decisionId: buffered.id,
            fetchDocument: async (url) => {
              urls.push(url.href);
              return readOfResponse(
                url.href === currentUrl
                  ? new Response(bytes)
                  : new Response(oldStatus === 200 ? oldBytes : null, {
                      status: oldStatus,
                    }),
              );
            },
            scopedDb,
            signal: new AbortController().signal,
          });
          expect(urls).toEqual([currentUrl]);
          expect(outcome.status).toBe("filled");
          if (outcome.status !== "filled") {
            throw new Error("expected current document");
          }
          expect(outcome.document.fulltext).toContain("Current decision text");
          expect(outcome.document.fulltext).not.toContain("Old decision text");
          expect(outcome.document.documentAst.metadata).toMatchObject({
            caseNumber: metadata.caseNumber,
            ecli: metadata.ecli,
            court: metadata.court,
            decisionDate: metadata.decisionDate,
            decisionType: metadata.decisionType,
          });
          const stored = await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { fulltext: true, sourceHash: true },
          });
          expect(stored).toEqual({
            fulltext: outcome.document.fulltext,
            sourceHash: "source-v2",
          });
        }
      });

      test("an unreadable download parks the decision instead of throwing", async () => {
        const id = await insertPending("unparseable");

        const outcome = await fetchWith(
          id,
          async () =>
            await Promise.resolve(
              new Response(new TextEncoder().encode("%PDF-1.7 not a pdf")),
            ),
        );

        expect(outcome).toEqual({
          status: "parked",
          failure: DOCUMENT_FETCH_FAILURE.UNPARSEABLE,
          detail: "UnrecoverableParseError",
        });
        const row = await readFetchState(id);
        expect(row?.documentFetchAttempts).toBe(MAX_DOCUMENT_FETCH_ATTEMPTS);
        // Still pending: a parser fix and a requeue can still read it.
        const [text] = await db
          .select({ fulltext: caseLawDecisions.fulltext })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id));
        expect(text?.fulltext).toBeNull();
      });

      /** A body one byte over the ceiling that starts with `head`. */
      const oversizedBody = (head: string): Uint8Array => {
        const bytes = new Uint8Array(MAX_DOCUMENT_PDF_BYTES + 1);
        bytes.set(new TextEncoder().encode(head));
        return bytes;
      };

      test("a PDF over the byte ceiling parks the decision with nothing stored", async () => {
        const id = await insertPending("too-large");

        const outcome = await fetchWith(
          id,
          async () =>
            await Promise.resolve(new Response(oversizedBody("%PDF-1.7\n"))),
        );

        expect(outcome).toEqual({
          status: "parked",
          failure: DOCUMENT_FETCH_FAILURE.TOO_LARGE,
          detail: `over-${MAX_DOCUMENT_PDF_BYTES}-bytes`,
        });
        const row = await readFetchState(id);
        expect(row?.documentFetchAttempts).toBe(MAX_DOCUMENT_FETCH_ATTEMPTS);
        const [stored] = await db
          .select({ fulltext: caseLawDecisions.fulltext })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id));
        expect(stored).toEqual({ fulltext: null });
      });

      test("a body over the byte ceiling that is not a PDF throws as any non-PDF body does", async () => {
        const id = await insertPending("too-large-html");

        const outcome = await fetchWith(
          id,
          async () =>
            await Promise.resolve(
              new Response(oversizedBody("<!doctype html><title>error")),
            ),
        ).then(
          (value: unknown) => ({ resolved: value }),
          (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(SkDocumentNonPdfError);
        const row = await readFetchState(id);
        expect(row?.documentFetchAttempts).toBeLessThan(
          MAX_DOCUMENT_FETCH_ATTEMPTS,
        );
      });

      test("a refused download defers the decision behind its own cooldown", async () => {
        const id = await insertPending("refused");

        const outcome = await fetchWith(
          id,
          async () =>
            await Promise.resolve(new Response(null, { status: 400 })),
        );

        expect(outcome).toEqual({
          status: "deferred",
          failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
          detail: "http-400",
        });
        const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);
        expect(onlyThese(queue, [id])).toEqual([]);
      });

      test("the attempt that reaches the threshold parks the decision", async () => {
        const id = await insertPending(
          "last-attempt",
          MAX_DOCUMENT_FETCH_ATTEMPTS - 1,
        );

        const outcome = await fetchWith(
          id,
          async () =>
            await Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    controller.error(
                      Object.assign(new TypeError("reset"), {
                        code: "ECONNRESET",
                      }),
                    );
                  },
                }),
              ),
            ),
        );

        expect(outcome).toEqual({
          status: "parked",
          failure: DOCUMENT_FETCH_FAILURE.NETWORK,
          detail: "TypeError:ECONNRESET",
        });
      });

      test("a publisher asking the walk to slow down still throws", async () => {
        const id = await insertPending("throttled");

        const outcome = fetchWith(
          id,
          async () =>
            await Promise.resolve(new Response(null, { status: 429 })),
        );

        expect(await rejectionOf(outcome)).toBeInstanceOf(AdapterFetchError);
      });
    });
  });
}
