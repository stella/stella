/**
 * A metadata-first source refreshes a decision long before it has the
 * document, and keeps refreshing it afterwards: the list endpoint's
 * fields move, the source hash changes, and the adapter returns the same
 * empty AST it returned at first sight. What must not happen is that
 * this puts the decision back to where it started — the stored document,
 * its object-storage pointers and its content hash have to survive a
 * refresh that carries nothing.
 *
 * The pointers are asserted under the default storage mode, where a
 * refresh that does not preserve would actively null them; the mirrored
 * objects are not written at all here, because the plan the preserving
 * refresh produces is not the one the mirror runs under.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const storedAst: DocumentAst = {
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "refresh",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/7/2026",
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

const STORED_TEXT = "Rozsudok\n\nOdôvodnenie:\n\nText.";
const STORED_KEYS = {
  textKey: "legal-corpus/stored/text.zst",
  sectionsKey: "legal-corpus/stored/sections.json.zst",
  astKey: "legal-corpus/stored/ast.json.zst",
} as const;
const STORED_CONTENT_HASH = "stored-content-hash";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("ingestion refresh — stored document", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  const db = drizzle(databaseUrl, {
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(tx));

  describe("ingestion refresh — stored document", () => {
    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    /** The row a hydration or a corpus backfill leaves behind. */
    const insertHydratedDecision = async (caseNumber: string) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          fulltext: STORED_TEXT,
          documentAst: storedAst,
          sections: [
            { index: 0, type: "header", title: null, text: "Rozsudok" },
          ],
          parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
          documentUrl: "https://example.test/refresh.pdf",
          metadata: { judge: "Old Judge" },
          sourceHash: "hash-before",
          textS3Key: STORED_KEYS.textKey,
          normalizedS3Key: STORED_KEYS.sectionsKey,
          astS3Key: STORED_KEYS.astKey,
          contentHash: STORED_CONTENT_HASH,
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    /** A decision the queue has not reached: metadata, and no document. */
    const insertEmptyDecision = async (caseNumber: string) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          documentUrl: "https://example.test/refresh.pdf",
          metadata: { judge: "Old Judge" },
          sourceHash: "hash-before",
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    /** What the adapter returns for a decision it has no document for. */
    const metadataOnlyResult = (caseNumber: string): IngestionResult => ({
      caseNumber,
      court: "Okresný súd",
      country: "SVK",
      language: "sk",
      decisionType: "rozsudok",
      documentUrl: "https://example.test/refresh.pdf",
      metadata: { judge: "New Judge" },
      rawHash: "hash-after",
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
      documentAst: EMPTY_AST,
    });

    const readDecision = async (id: SafeId<"caseLawDecision">) =>
      await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: {
          fulltext: true,
          documentAst: true,
          sections: true,
          metadata: true,
          sourceHash: true,
          decisionType: true,
          textS3Key: true,
          normalizedS3Key: true,
          astS3Key: true,
          contentHash: true,
        },
      });

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
          name: "SK courts refresh test",
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

    test("a metadata-only refresh leaves the stored document alone", async () => {
      const caseNumber = `refresh-${suffix}`;
      const id = await insertHydratedDecision(caseNumber);

      const outcome = await processDecision({
        input: metadataOnlyResult(caseNumber),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      expect(outcome.inserted).toBe(true);

      const row = await readDecision(id);
      // The document, exactly as it was stored.
      expect(row?.fulltext).toBe(STORED_TEXT);
      expect(
        row?.documentAst && "blocks" in row.documentAst
          ? row.documentAst.blocks.length
          : 0,
      ).toBe(1);
      expect(row?.sections).toHaveLength(1);
      // And the pointers to it. A refresh that does not preserve nulls
      // these, so their survival is the assertion.
      expect(row?.textS3Key).toBe(STORED_KEYS.textKey);
      expect(row?.normalizedS3Key).toBe(STORED_KEYS.sectionsKey);
      expect(row?.astS3Key).toBe(STORED_KEYS.astKey);
      expect(row?.contentHash).toBe(STORED_CONTENT_HASH);

      // The metadata this refresh actually carried did land.
      expect(row?.metadata).toMatchObject({ judge: "New Judge" });
      expect(row?.decisionType).toBe("rozsudok");
      expect(row?.sourceHash).toBe("hash-after");
    });

    test("a document landing mid-refresh is not overwritten by the refresh", async () => {
      // The window the guard closes: the refresh reads a decision with
      // no document, a backfill commits one while it is deciding, and
      // the write that follows would put the empty payload over it. The
      // condition rides in the payload write's WHERE, so the row that
      // acquired a document simply falls out of scope.
      const caseNumber = `refresh-race-${suffix}`;
      const id = await insertEmptyDecision(caseNumber);

      let transactions = 0;
      const racingDb: ScopedDb = async (callback) => {
        transactions += 1;
        // Transactions in order: the decision lookup, the check for a
        // stored document, then the row write. Injecting as the third
        // opens exactly the window the guard closes — the check has
        // already answered "no document", and the write is next.
        if (transactions === 3) {
          await db
            .update(caseLawDecisions)
            .set({
              fulltext: STORED_TEXT,
              documentAst: storedAst,
              sections: [
                { index: 0, type: "header", title: null, text: "Rozsudok" },
              ],
            })
            .where(eq(caseLawDecisions.id, id));
        }
        return await scopedDb(callback);
      };

      await processDecision({
        input: metadataOnlyResult(caseNumber),
        observationOrder: 1n,
        sourceId,
        scopedDb: racingDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      // If the sequence ever changes, the injection no longer lands in
      // the window and this test would pass without exercising it.
      expect(transactions).toBe(3);

      const row = await readDecision(id);
      expect(row?.fulltext).toBe(STORED_TEXT);
      expect(
        row?.documentAst && "blocks" in row.documentAst
          ? row.documentAst.blocks.length
          : 0,
      ).toBe(1);
      // The metadata this refresh carried is unconditional and lands.
      expect(row?.metadata).toMatchObject({ judge: "New Judge" });
      expect(row?.sourceHash).toBe("hash-after");
    });

    test("a refresh that carries a document still replaces the stored one", async () => {
      // The guard against preserving too much: a source that does send
      // the document must still be able to correct what is stored.
      const caseNumber = `refresh-doc-${suffix}`;
      const id = await insertHydratedDecision(caseNumber);

      await processDecision({
        input: {
          ...metadataOnlyResult(caseNumber),
          fulltext: "Rozsudok\n\nOdôvodnenie:\n\nRevidovaný text.",
        },
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const row = await readDecision(id);
      expect(row?.fulltext).toContain("Revidovaný");
      // This refresh supersedes what the corpus holds, so the row may
      // not keep pointing at objects that no longer match its columns.
      expect(row?.textS3Key).toBeNull();
      expect(row?.contentHash).toBeNull();
    });
  });
}
