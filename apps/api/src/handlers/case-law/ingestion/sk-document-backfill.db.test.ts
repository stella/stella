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
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  loadPendingDocuments,
  loadRemainingDocuments,
  markDocumentUnavailable,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  recordDocumentFetchAttempt,
  recordDocumentFetchRequest,
  storeBackfilledDocument,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import type { PendingDocument } from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import type { SafeId } from "@/api/lib/branded-types";

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
      // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
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
      documentFetchAttempts?: number;
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
          documentFetchAttempts: values.documentFetchAttempts,
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

      await storeBackfilledDocument(
        id,
        {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [
            { index: 0, type: "header", title: null, text: "Rozsudok" },
          ],
        },
        scopedDb,
      );

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
      expect(row?.parserVersion).toBe(PARSER_VERSION);
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

      await storeBackfilledDocument(id, stored, scopedDb);
      // A second fetch of the same decision — the queue and a reader can
      // both reach it — must converge rather than replace what is there.
      await storeBackfilledDocument(
        id,
        { ...stored, fulltext: "Stale re-parse." },
        scopedDb,
      );

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

      await storeBackfilledDocument(
        id,
        {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [],
        },
        scopedDb,
      );
      await markDocumentUnavailable(id, scopedDb);

      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: { fulltext: true },
      });

      expect(row?.fulltext).toContain("Odôvodnenie");
    });

    test("only the first reader's request is kept, every attempt is counted", async () => {
      const id = await insertDecision({
        caseNumber: `request-${suffix}`,
        fulltext: null,
        documentUrl: "https://example.test/request.pdf",
      });

      await recordDocumentFetchRequest(id, scopedDb);
      const firstRequest = await readFetchState(id);
      await recordDocumentFetchRequest(id, scopedDb);
      await recordDocumentFetchAttempt(id, scopedDb);
      await recordDocumentFetchAttempt(id, scopedDb);
      const afterRepeat = await readFetchState(id);

      // A second reader must not push the decision back down its tier.
      expect(afterRepeat?.documentFetchRequestedAt).toEqual(
        firstRequest?.documentFetchRequestedAt ?? null,
      );
      expect(afterRepeat?.documentFetchAttempts).toBe(2);
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
  });
}
