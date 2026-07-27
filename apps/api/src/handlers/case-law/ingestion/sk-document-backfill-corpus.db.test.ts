/**
 * A metadata-first ingest writes a corpus payload before the document
 * exists — an empty one — and points the row at it. When the document
 * finally arrives, filling only the Postgres columns leaves every
 * corpus-preferring reader, and the corpus indexer that compares
 * hashes, looking at the empty payload. What has to hold is that the
 * store rewrites the objects and moves the row's keys and hash onto
 * them, in that order.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { WriteCorpusResult } from "@/api/handlers/case-law/corpus-storage";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const parsedAst: DocumentAst = {
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "corpus",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/9/2026",
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
  describe.skip("sk-courts document backfill — corpus storage", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  const db = drizzle(databaseUrl, {
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
    await db.transaction(async (tx) => await callback(tx));

  const NEW_KEYS = {
    textKey: "legal-corpus/new/text.zst",
    sectionsKey: "legal-corpus/new/sections.json.zst",
    astKey: "legal-corpus/new/ast.json.zst",
  } as const;
  const NEW_CONTENT_HASH = "new-content-hash";

  type WriteInput = { documentId: string; jurisdiction: string; text: unknown };
  const corpusWrites: WriteInput[] = [];
  /** The row's hash at the moment the objects were written. */
  const hashesDuringWrite: (string | null)[] = [];
  let writtenDecisionId: SafeId<"caseLawDecision"> | null = null;

  const writeCorpusDocumentMock = mock(
    async (input: WriteInput): Promise<WriteCorpusResult> => {
      corpusWrites.push(input);
      if (writtenDecisionId !== null) {
        const row = await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: writtenDecisionId } },
          columns: { contentHash: true },
        });
        hashesDuringWrite.push(row?.contentHash ?? null);
      }
      return { ...NEW_KEYS, contentHash: NEW_CONTENT_HASH };
    },
  );

  // The store reads the mode at import, so it is set before the module
  // graph loads rather than mocked.
  process.env["CORPUS_STORAGE_MODE"] = "dual-write";

  const realCorpusStorage =
    await import("@/api/handlers/case-law/corpus-storage");
  void mock.module("@/api/handlers/case-law/corpus-storage", () => ({
    ...realCorpusStorage,
    writeCorpusDocument: writeCorpusDocumentMock,
  }));

  const { storeBackfilledDocument } =
    await import("@/api/handlers/case-law/ingestion/sk-document-backfill");
  const { EMPTY_CORPUS_CONTENT_HASHES } = realCorpusStorage;

  describe("sk-courts document backfill — corpus storage", () => {
    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    beforeAll(async () => {
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
          name: "SK courts corpus test",
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

    test("moves the row's keys and hash onto the real document", async () => {
      const emptyHash = EMPTY_CORPUS_CONTENT_HASHES.at(0) ?? "";
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `corpus-${suffix}`,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          fulltext: null,
          documentUrl: "https://example.test/corpus.pdf",
          // What a metadata-first ingest left behind: keys and a hash
          // that point at the empty payload.
          textS3Key: "legal-corpus/empty/text.zst",
          normalizedS3Key: "legal-corpus/empty/sections.json.zst",
          astS3Key: "legal-corpus/empty/ast.json.zst",
          contentHash: emptyHash,
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      writtenDecisionId = row.id;

      await storeBackfilledDocument({
        decision: {
          id: row.id,
          caseNumber: `corpus-${suffix}`,
          ecli: null,
          court: "Okresný súd",
          country: "SVK",
          decisionDate: null,
          decisionType: null,
          documentUrl: "https://example.test/corpus.pdf",
        },
        document: {
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
          documentAst: parsedAst,
          sections: [
            { index: 0, type: "header", title: null, text: "Rozsudok" },
          ],
        },
        scopedDb,
      });

      const stored = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: row.id } },
        columns: {
          fulltext: true,
          textS3Key: true,
          normalizedS3Key: true,
          astS3Key: true,
          contentHash: true,
          indexedHash: true,
        },
      });

      // The document reached object storage under this decision's id
      // and jurisdiction, not just the columns.
      expect(corpusWrites).toHaveLength(1);
      expect(corpusWrites.at(0)).toMatchObject({
        documentId: row.id,
        jurisdiction: "SVK",
        text: "Rozsudok\n\nOdôvodnenie:\n\nText.",
      });
      // Objects first: the row still pointed at the empty payload while
      // they were being written.
      expect(hashesDuringWrite).toEqual([emptyHash]);

      expect(stored?.fulltext).toContain("Odôvodnenie");
      expect(stored?.textS3Key).toBe(NEW_KEYS.textKey);
      expect(stored?.normalizedS3Key).toBe(NEW_KEYS.sectionsKey);
      expect(stored?.astS3Key).toBe(NEW_KEYS.astKey);
      // The corpus indexer compares indexedHash against contentHash, so
      // moving the hash is what makes the row stale and re-indexed.
      expect(stored?.contentHash).toBe(NEW_CONTENT_HASH);
      expect(stored?.indexedHash).not.toBe(NEW_CONTENT_HASH);
    });
  });
}
