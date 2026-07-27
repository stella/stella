/**
 * A metadata-first ingest writes a corpus payload before the document
 * exists — an empty one — and points the row at it. When the document
 * finally arrives, filling only the Postgres columns leaves every
 * corpus-preferring reader, and the corpus indexer that compares
 * hashes, looking at the empty payload. What has to hold is that the
 * store rewrites the objects and moves the row's keys and hash onto
 * them, in that order.
 *
 * The corpus writer is injected rather than replaced at the module
 * level: a whole-suite run shares one module registry, so a
 * module-level double belongs to whichever file imported the subject
 * first, and the others silently assert against the real one.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { WriteCorpusResult } from "@/api/handlers/case-law/corpus-storage";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/handlers/case-law/corpus-storage";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { storeBackfilledDocument } from "@/api/handlers/case-law/ingestion/sk-document-backfill";
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

const NEW_KEYS = {
  textKey: "legal-corpus/new/text.zst",
  sectionsKey: "legal-corpus/new/sections.json.zst",
  astKey: "legal-corpus/new/ast.json.zst",
} as const;
const NEW_CONTENT_HASH = "new-content-hash";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("sk-courts document backfill — corpus storage", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("sk-courts document backfill — corpus storage", () => {
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
      contentHash?: string;
      keys?: boolean;
    }) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: values.caseNumber,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          fulltext: null,
          documentUrl: "https://example.test/corpus.pdf",
          // What a metadata-first ingest leaves behind under corpus
          // storage: keys and a hash that point at the empty payload.
          textS3Key: values.keys ? "legal-corpus/empty/text.zst" : null,
          normalizedS3Key: values.keys
            ? "legal-corpus/empty/sections.json.zst"
            : null,
          astS3Key: values.keys ? "legal-corpus/empty/ast.json.zst" : null,
          contentHash: values.contentHash,
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    const decisionFor = (
      id: SafeId<"caseLawDecision">,
      caseNumber: string,
    ) => ({
      id,
      caseNumber,
      ecli: null,
      court: "Okresný súd",
      country: "SVK",
      decisionDate: null,
      decisionType: null,
      documentUrl: "https://example.test/corpus.pdf",
    });

    const parsedDocument = {
      fulltext: "Rozsudok\n\nOdôvodnenie:\n\nText.",
      documentAst: parsedAst,
      sections: [
        { index: 0, type: "header" as const, title: null, text: "Rozsudok" },
      ],
    };

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
      const caseNumber = `corpus-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        contentHash: emptyHash,
        keys: true,
      });

      type WriteInput = {
        documentId: string;
        jurisdiction: string;
        text: string | null;
      };
      const corpusWrites: WriteInput[] = [];
      /** The row's hash at the moment the objects were written. */
      const hashesDuringWrite: (string | null)[] = [];

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        writeCorpus: async (input): Promise<WriteCorpusResult> => {
          corpusWrites.push({
            documentId: input.documentId,
            jurisdiction: input.jurisdiction,
            text: input.text,
          });
          const during = await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { contentHash: true },
          });
          hashesDuringWrite.push(during?.contentHash ?? null);
          return { ...NEW_KEYS, contentHash: NEW_CONTENT_HASH };
        },
      });

      const stored = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
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
      expect(corpusWrites).toEqual([
        {
          documentId: id,
          jurisdiction: "SVK",
          text: parsedDocument.fulltext,
        },
      ]);
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

    test("writes the columns alone where corpus storage is off", async () => {
      const caseNumber = `corpus-off-${suffix}`;
      const id = await insertDecision({ caseNumber });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        writeCorpus: null,
      });

      const stored = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: { fulltext: true, textS3Key: true, contentHash: true },
      });

      expect(stored?.fulltext).toContain("Odôvodnenie");
      expect(stored?.textS3Key).toBeNull();
      expect(stored?.contentHash).toBeNull();
    });
  });
}
