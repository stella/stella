import { panic } from "better-result";
/**
 * The read reports whether a decision's document is still to come or is
 * not coming, and only the first may be fetched for the reader. The
 * difference is a NULL text column versus an empty one, which is SQL, so
 * it is tested against Postgres: getting it wrong either strands a
 * fetchable decision or has every view of an unfetchable one take a
 * claim that can never succeed.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { inArray, eq } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  decisionRecordQuery,
  readDecisionHandler,
} from "@/api/handlers/case-law/decisions/get";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  listPublicDecisionLanguageAlternates,
  readPublicDecisionLanguageAlternatesQuery,
} from "@/api/lib/case-law/language-alternates";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { rowHoldsDocument } from "@/api/lib/case-law/stored-payload";
import {
  corpusKeys,
  EMPTY_CORPUS_CONTENT_HASHES,
} from "@/api/lib/legal-search/corpus-storage";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision read — document state", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("decision read — document state", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (fulltext: string | null) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `state-${created.length}-${suffix}`,
          court: "Synthetic court",
          country: "CZE",
          language: "cs",
          fulltext,
          documentUrl: "https://example.test/state.pdf",
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    const readState = async (id: SafeId<"caseLawDecision">) => {
      const subject =
        (await withRedistributableSubject(
          caseLawPublicReadDb,
          {
            kind: "id",
            id,
          },
          async (gated) => gated,
        )) ?? panic("expected a redistributable subject");
      const decision = await readDecisionHandler({ subject });
      if (!("documentPending" in decision)) {
        throw new Error("expected a readable decision");
      }
      return {
        hasDocument: decision.hasDocument,
        pending: decision.documentPending,
        unavailable: decision.documentUnavailable,
      };
    };

    beforeAll(async () => {
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.CZ_REGIONAL } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          name: "Public decision read-state test",
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
    });

    test("a decision nobody has fetched is pending", async () => {
      expect(await readState(await insertDecision(null))).toEqual({
        hasDocument: false,
        pending: true,
        unavailable: false,
      });
    });

    test("a decision the source had nothing for is terminal", async () => {
      // The empty string is the pipeline's "tried and got nothing"
      // marker. Reporting it as pending would send every later view back
      // through the fetch path for a document that does not exist.
      expect(await readState(await insertDecision(""))).toEqual({
        hasDocument: false,
        pending: false,
        unavailable: true,
      });
    });

    test("a decision with its document is neither", async () => {
      expect(
        await readState(await insertDecision("Decision\n\nReasons.")),
      ).toEqual({ hasDocument: true, pending: false, unavailable: false });
    });
    test("public and full document predicates agree across stored payload states", async () => {
      const id = await insertDecision(null);
      const contentHash = "a".repeat(64);
      const keys = corpusKeys({
        documentId: id,
        jurisdiction: "CZE",
        contentHash,
      });
      const emptyHash =
        EMPTY_CORPUS_CONTENT_HASHES.at(0) ??
        panic("Expected an empty corpus hash");
      const empty = {
        fulltext: null,
        contentHash: null,
        textS3Key: null,
        normalizedS3Key: null,
        astS3Key: null,
      };
      const complete = {
        ...empty,
        contentHash,
        textS3Key: keys.textKey,
        normalizedS3Key: keys.sectionsKey,
        astS3Key: keys.astKey,
      };
      const fixtures = [
        { name: "textless", values: empty, expected: false },
        {
          name: "empty text",
          values: { ...empty, fulltext: "" },
          expected: false,
        },
        {
          name: "inline text",
          values: { ...empty, fulltext: "Document" },
          expected: true,
        },
        { name: "trimmed complete corpus", values: complete, expected: true },
        {
          name: "canonical empty",
          values: { ...complete, contentHash: emptyHash },
          expected: false,
        },
        {
          name: "normalized key alone",
          values: { ...empty, contentHash, normalizedS3Key: keys.sectionsKey },
          expected: false,
        },
        {
          name: "text key alone",
          values: { ...empty, contentHash, textS3Key: keys.textKey },
          expected: false,
        },
        {
          name: "unconfirmed corpus",
          values: { ...complete, contentHash: null },
          expected: false,
        },
      ];
      for (const { name, values, expected } of fixtures) {
        await db
          .update(caseLawDecisions)
          .set(values)
          .where(eq(caseLawDecisions.id, id));
        const [full] = await db
          .select({ hasDocument: rowHoldsDocument })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id));
        const publicRow = await caseLawPublicReadDb(
          async (tx) => await decisionRecordQuery(tx, id),
        );
        expect(full?.hasDocument, name).toBe(expected);
        expect(publicRow?.hasDocument, name).toBe(full?.hasDocument);
      }
    });

    test("detail alternates prefer a document while collection alternates retain ID order", async () => {
      const ids = [
        await insertDecision(null),
        await insertDecision("Document"),
      ].toSorted();
      const lowId = ids.at(0) ?? panic("Expected the first duplicate");
      const highId = ids.at(1) ?? panic("Expected the second duplicate");
      const englishId = await insertDecision("English document");
      const languageGroupKey = `detail-alternates-${suffix}`;
      await db
        .update(caseLawDecisions)
        .set({ languageGroupKey, fulltext: "" })
        .where(eq(caseLawDecisions.id, lowId));
      await db
        .update(caseLawDecisions)
        .set({ languageGroupKey, fulltext: "Document" })
        .where(eq(caseLawDecisions.id, highId));
      await db
        .update(caseLawDecisions)
        .set({ languageGroupKey, language: "en" })
        .where(eq(caseLawDecisions.id, englishId));
      const collection = await caseLawPublicReadDb(
        async (tx) =>
          await readPublicDecisionLanguageAlternatesQuery(tx, [
            languageGroupKey,
          ]),
      );
      expect(collection.find((row) => row.language === "cs")?.id).toBe(lowId);
      const detail = await caseLawPublicReadDb(
        async (tx) =>
          await listPublicDecisionLanguageAlternates({ tx, languageGroupKey }),
      );
      expect(detail.find((row) => row.language === "cs")).toMatchObject({
        id: highId,
        hasDocument: true,
      });
      expect(detail).toHaveLength(2);
    });
  });
}
