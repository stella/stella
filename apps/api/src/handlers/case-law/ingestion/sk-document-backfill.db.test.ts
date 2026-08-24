/**
 * The backfill's risk is its queue query, not its parsing: it decides
 * which rows are still waiting and in what order, and a wrong predicate
 * either loops on the same decisions forever, silently skips the
 * backlog, or leaves the decisions readers are waiting on at the back.
 * That is SQL, so it is tested against Postgres.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import {
  claimDocumentFetch,
  loadPendingDocuments,
  loadRemainingDocuments,
  markDocumentUnavailable,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  recordDocumentFetchRequest,
  storeBackfilledDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";

/**
 * Wide enough to hold the whole queue on the migrated-but-unseeded
 * database this suite runs against, so an ordering assertion sees every
 * row it created.
 */
const QUEUE_READ_LIMIT = 500;

/**
 * The queue row a store call would have come from. Only the id and the
 * jurisdiction are read, and this suite runs with corpus storage off,
 * so the rest is filler.
 */
const pendingFor = (id: SafeId<"caseLawDecision">): PendingDocument => ({
  id,
  caseNumber: "stored",
  ecli: null,
  court: "Okresný súd",
  country: "SVK",
  decisionDate: null,
  decisionType: null,
  documentUrl: null,
});

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
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
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
    }) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
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

    afterAll(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
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
        decision: pendingFor(id),
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
      expect(row?.parserVersion).toBe(
        PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
      );
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

      await markDocumentUnavailable(id, scopedDb);

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

      await markDocumentUnavailable(id, scopedDb);

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

      await storeBackfilledDocument({
        decision: pendingFor(id),
        document: stored,
        scopedDb,
      });
      // A second fetch of the same decision — the queue and a reader can
      // both reach it — must converge rather than replace what is there.
      await storeBackfilledDocument({
        decision: pendingFor(id),
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

      await storeBackfilledDocument({
        decision: pendingFor(id),
        document: {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [],
        },
        scopedDb,
      });
      await markDocumentUnavailable(id, scopedDb);

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

      // The source refreshed the decision while the document was being
      // fetched, so what was parsed describes a row that no longer
      // exists in that form.
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: "hash-after-refresh" })
        .where(eq(caseLawDecisions.id, id));

      await storeBackfilledDocument({
        decision: pendingFor(id),
        document,
        scopedDb,
        claimedSourceHash: "hash-at-claim",
      });

      expect(
        (
          await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { fulltext: true },
          })
        )?.fulltext,
      ).toBeNull();

      // Fetched again against the row as it now stands, the same
      // document stores.
      await storeBackfilledDocument({
        decision: pendingFor(id),
        document,
        scopedDb,
        claimedSourceHash: "hash-after-refresh",
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

      expect(claim).toEqual({ status: "claimed", sourceHash: "hash-at-claim" });
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

    test("decisions the source keeps refusing sink below untried ones", async () => {
      // The livelock this prevents: a source answering 403 for the
      // newest page would otherwise hand back the same rows every run,
      // because they are the newest, and nothing behind them would ever
      // be reached.
      const refusedIds = await Promise.all(
        [1, 2, 3].map(
          async (n) =>
            await insertDecision({
              caseNumber: `livelock-refused-${n}-${suffix}`,
              fulltext: null,
              documentUrl: `https://example.test/refused-${n}.pdf`,
              // Newest decisions, so date order alone would put them first.
              decisionDate: `2026-08-0${n}`,
              documentFetchAttempts: MAX_PRIORITY_FETCH_ATTEMPTS,
              documentFetchAttemptedAt: new Date(
                Date.now() - 24 * 60 * 60 * 1000,
              ),
            }),
        ),
      );
      const untried = await insertDecision({
        caseNumber: `livelock-untried-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/untried.pdf",
        decisionDate: "2026-01-01",
      });

      const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);

      expect(onlyThese(queue, [...refusedIds, untried]).at(0)).toBe(untried);
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
        after: { attempts: 0, decisionDate: "2026-04-02", id: first },
      });

      expect(onlyThese(page, [first, second])).toEqual([second]);
    });
  });
}
