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

import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CorpusPackError,
  decodePackFooter,
} from "@/api/lib/legal-search/corpus-pack";
import type { PackFooter } from "@/api/lib/legal-search/corpus-pack";
import type { putCorpusPacks } from "@/api/lib/legal-search/corpus-pack-writer";
import {
  corpusContentHash,
  EMPTY_CORPUS_CONTENT_HASHES,
} from "@/api/lib/legal-search/corpus-storage";
import {
  markDocumentUnavailable,
  pendingDocumentPredicate,
  storeBackfilledDocument,
} from "@/api/lib/legal-search/sk-document-backfill";

/** A pack that does not decode fails the test rather than a case in it. */
const unwrapPackFooter = (
  decoded: Result<PackFooter, CorpusPackError>,
): PackFooter => {
  if (Result.isError(decoded)) {
    throw decoded.error;
  }
  return decoded.value;
};

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

/** The keys a pre-migration writer left on a row, for the legacy case below. */
const LEGACY_CONTENT_HASH = "new-content-hash";
const LEGACY_KEYS = {
  textKey: "legal-corpus/new/text.zst",
  sectionsKey: "legal-corpus/new/sections.json.zst",
  astKey: "legal-corpus/new/ast.json.zst",
} as const;

/**
 * A transfer that lands. The addresses are no longer the test's to choose:
 * the store packs the document it was handed, and every address is a range
 * inside that pack.
 */
const landingTransfer: typeof putCorpusPacks = async () =>
  await Promise.resolve(Result.ok(undefined));

/** Every stored pointer is a member of a pack under this jurisdiction. */
const packedUnder = (jurisdiction: string) =>
  expect.stringContaining(
    `pack:legal-corpus/packs/jurisdiction=${jurisdiction}/`,
  );

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
      await db.transaction(async (tx) => await callback(tx));

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (values: {
      caseNumber: string;
      contentHash?: string;
      keys?: boolean;
      redactedAt?: Date;
      mirrorStatus?: (typeof CASE_LAW_CORPUS_MIRROR_STATUS)[keyof typeof CASE_LAW_CORPUS_MIRROR_STATUS];
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
          redactedAt: values.redactedAt,
          corpusMirrorStatus: values.mirrorStatus,
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
    /** What the store hashes the document to, and settles the row with. */
    const documentContentHash = corpusContentHash({
      text: parsedDocument.fulltext,
      sections: parsedDocument.sections,
      ast: parsedDocument.documentAst,
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

      /** What each transferred pack carries, and for which document. */
      const packedMembers: { packKey: string; documentId: string }[] = [];
      /** The row's hash at the moment the pack was transferred. */
      const hashesDuringWrite: (string | null)[] = [];

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        putPacks: async ({ packs }) => {
          for (const pack of packs) {
            const footer = unwrapPackFooter(await decodePackFooter(pack.bytes));
            packedMembers.push(
              ...footer.members.map(({ documentId }) => ({
                packKey: pack.packKey,
                documentId,
              })),
            );
          }
          const during = await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: id } },
            columns: { contentHash: true },
          });
          hashesDuringWrite.push(during?.contentHash ?? null);
          return Result.ok(undefined);
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
        },
      });

      // The document reached object storage as members of one pack under
      // this decision's id and jurisdiction, not just the columns.
      expect(packedMembers).toEqual([
        { packKey: packedUnder("SVK"), documentId: id },
        { packKey: packedUnder("SVK"), documentId: id },
        { packKey: packedUnder("SVK"), documentId: id },
      ]);
      // The pack first: the row still pointed at the empty payload while it
      // was being transferred.
      expect(hashesDuringWrite).toEqual([emptyHash]);

      expect(stored?.fulltext).toContain("Odôvodnenie");
      expect(stored?.textS3Key).toEqual(packedUnder("SVK"));
      expect(stored?.normalizedS3Key).toEqual(packedUnder("SVK"));
      expect(stored?.astS3Key).toEqual(packedUnder("SVK"));
      expect(stored?.contentHash).toBe(documentContentHash);
    });

    test("writes the columns alone where corpus storage is off", async () => {
      const caseNumber = `corpus-off-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        putPacks: null,
      });

      const stored = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: {
          corpusMirrorStatus: true,
          fulltext: true,
          textS3Key: true,
          contentHash: true,
        },
      });

      expect(stored?.corpusMirrorStatus).toBe(
        CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
      );
      expect(stored?.fulltext).toContain("Odôvodnenie");
      expect(stored?.textS3Key).toBeNull();
      expect(stored?.contentHash).toBeNull();
    });

    test("settles a pending mirror with the backfilled pointers", async () => {
      const caseNumber = `corpus-pending-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        putPacks: landingTransfer,
      });

      const stored = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: {
          corpusMirrorStatus: true,
          textS3Key: true,
          normalizedS3Key: true,
          astS3Key: true,
          contentHash: true,
        },
      });

      expect(stored).toMatchObject({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        textS3Key: packedUnder("SVK"),
        normalizedS3Key: packedUnder("SVK"),
        astS3Key: packedUnder("SVK"),
        contentHash: documentContentHash,
      });
    });

    /**
     * Under canonical storage the objects are the payload, so a store that
     * also filled the columns would put the row straight back into the
     * pre-cutover shape — the state an external cleanup pass exists to
     * remove, recreated by the writer faster than the pass can clear it.
     * The queue predicate reads the result (row-specific hash, no surviving
     * AST artifact) as corpus-served rather than pending, so the decision
     * does not come back round.
     */
    test("canonical storage settles with the columns already empty", async () => {
      const caseNumber = `corpus-canonical-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      const outcome = await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "canonical",
        scopedDb,
        putPacks: landingTransfer,
      });

      expect(outcome).toBe("stored");
      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: {
            corpusMirrorStatus: true,
            fulltext: true,
            sections: true,
            documentAst: true,
            textS3Key: true,
            normalizedS3Key: true,
            astS3Key: true,
            contentHash: true,
          },
        }),
      ).toEqual({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        fulltext: null,
        sections: null,
        documentAst: null,
        textS3Key: packedUnder("SVK"),
        normalizedS3Key: packedUnder("SVK"),
        astS3Key: packedUnder("SVK"),
        contentHash: documentContentHash,
      });
    });

    /**
     * A PDF parse is CPU-bound and uncancellable, so an attempt can outlive
     * its 120s claim: a retry stores the document while the first attempt
     * is still running, then the first attempt finishes empty and marks the
     * decision unavailable. That write clears the corpus pointers, and
     * under canonical storage the stored document no longer shows in the
     * text column, so a fence that reads only `fulltext` would let a late
     * failure orphan a confirmed payload.
     */
    test("a late unavailable marking cannot erase a stored canonical payload", async () => {
      const caseNumber = `corpus-late-unavailable-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "canonical",
        scopedDb,
        putPacks: landingTransfer,
      });

      // The attempt that was overtaken, finishing with nothing to store.
      await markDocumentUnavailable(id, scopedDb);

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: {
            fulltext: true,
            textS3Key: true,
            normalizedS3Key: true,
            astS3Key: true,
            contentHash: true,
          },
        }),
      ).toEqual({
        fulltext: null,
        textS3Key: packedUnder("SVK"),
        normalizedS3Key: packedUnder("SVK"),
        astS3Key: packedUnder("SVK"),
        contentHash: documentContentHash,
      });
    });

    /**
     * The same fence from the other side: a store that lands after another
     * attempt already filled the decision is superseded, not applied.
     */
    test("a late store cannot overwrite a stored canonical payload", async () => {
      const caseNumber = `corpus-late-store-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });
      const store = async () =>
        await storeBackfilledDocument({
          decision: decisionFor(id, caseNumber),
          document: parsedDocument,
          mode: "canonical",
          scopedDb,
          putPacks: landingTransfer,
        });

      expect(await store()).toBe("stored");
      expect(await store()).toBe("superseded");
    });

    /**
     * The queue must not hand a corpus-served decision back as pending
     * work: under canonical its text column is null, which is the shape
     * the queue reads as "never fetched".
     */
    test("a stored canonical decision leaves the pending queue", async () => {
      const caseNumber = `corpus-queue-exit-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      const stillPending = async () =>
        Boolean(
          (
            await db
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(and(eq(caseLawDecisions.id, id), pendingDocumentPredicate))
              .limit(1)
          ).at(0),
        );

      expect(await stillPending()).toBe(true);

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "canonical",
        scopedDb,
        putPacks: landingTransfer,
      });

      expect(await stillPending()).toBe(false);
    });

    test("dual-write storage keeps the columns alongside the objects", async () => {
      const caseNumber = `corpus-dual-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "dual-write",
        scopedDb,
        putPacks: landingTransfer,
      });

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: { fulltext: true, textS3Key: true, contentHash: true },
        }),
      ).toMatchObject({
        fulltext: parsedDocument.fulltext,
        textS3Key: packedUnder("SVK"),
        contentHash: documentContentHash,
      });
    });

    /**
     * The columns are dropped because object storage holds the payload, so
     * a store with no corpus write behind it keeps them whatever the mode
     * says: they are the only copy.
     */
    test("canonical storage with no corpus write keeps the columns", async () => {
      const caseNumber = `corpus-canonical-nowrite-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "canonical",
        scopedDb,
        putPacks: null,
      });

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: { fulltext: true, textS3Key: true, contentHash: true },
        }),
      ).toMatchObject({
        fulltext: parsedDocument.fulltext,
        textS3Key: null,
        contentHash: null,
      });
    });

    /**
     * A corpus write that throws never reaches the row write at all, so the
     * decision keeps its pending mirror and its empty columns — still
     * queued, exactly as before this store ran.
     */
    test("canonical storage leaves the row untouched when the corpus write fails", async () => {
      const caseNumber = `corpus-canonical-failed-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      const outcome = await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        mode: "canonical",
        scopedDb,
        putPacks: async () =>
          await Promise.resolve(
            Result.err(new CorpusPackError({ message: "bucket unreachable" })),
          ),
      });

      // Nothing was stored, so the decision is reported exactly as one this
      // store did not fill: it keeps its place in the queue.
      expect(outcome).toBe("superseded");
      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: {
            corpusMirrorStatus: true,
            fulltext: true,
            textS3Key: true,
          },
        }),
      ).toMatchObject({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        fulltext: null,
        textS3Key: null,
      });
    });

    test("settles a legacy writer that cannot name the mirror status", async () => {
      const caseNumber = `corpus-legacy-writer-${suffix}`;
      const id = await insertDecision({
        caseNumber,
        mirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: { corpusMirrorStatus: true },
        }),
      ).toMatchObject({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      });

      // This is the shape emitted by an already-running pre-migration
      // backfill: it writes every corpus pointer but knows nothing about
      // corpus_mirror_status. The compatibility trigger must complete the
      // new state transition before the CHECK constraints run.
      await db.execute(sql`
        UPDATE ${caseLawDecisions}
        SET text_s3_key = ${LEGACY_KEYS.textKey},
            normalized_s3_key = ${LEGACY_KEYS.sectionsKey},
            ast_s3_key = ${LEGACY_KEYS.astKey},
            content_hash = ${LEGACY_CONTENT_HASH}
        WHERE id = ${id}
      `);

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: {
            corpusMirrorStatus: true,
            contentHash: true,
          },
        }),
      ).toMatchObject({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        contentHash: LEGACY_CONTENT_HASH,
      });
    });

    test("deferred backfill cannot restore a redacted decision", async () => {
      const caseNumber = `corpus-redacted-backfill-${suffix}`;
      const redactedAt = new Date("2026-07-31T12:00:00.000Z");
      const id = await insertDecision({ caseNumber, redactedAt });

      const outcome = await storeBackfilledDocument({
        decision: decisionFor(id, caseNumber),
        document: parsedDocument,
        scopedDb,
        putPacks: null,
      });

      expect(outcome).toBe("superseded");
      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: id } },
          columns: { redactedAt: true, fulltext: true, contentHash: true },
        }),
      ).toMatchObject({
        redactedAt,
        fulltext: null,
        contentHash: null,
      });
      expect(
        await db
          .select({ id: caseLawSearchDocuments.decisionId })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: caseLawSearchDocumentPreviewPassages.decisionId })
          .from(caseLawSearchDocumentPreviewPassages)
          .where(eq(caseLawSearchDocumentPreviewPassages.decisionId, id)),
      ).toHaveLength(0);
    });
  });
}
