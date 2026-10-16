import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import {
  decisionRecordQuery,
  readDecisionHandler,
} from "@/api/handlers/case-law/decisions/get";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("durable extraction warnings", () => {
    test("requires an explicitly enabled Postgres database", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("durable extraction warnings", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    const corpus = {
      mode: "off",
      transfer: {
        layout: "packs",
        putPacks: () => panic("Inline test must not transfer corpus packs"),
      },
    } satisfies CaseLawCorpusDependencies;
    let sourceId: SafeId<"caseLawSource">;
    const suffix = Bun.randomUUIDv7();
    beforeAll(async () => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: `extraction-warnings-${suffix}`,
          name: "Synthetic extraction source",
          enabled: false,
          descriptor: {
            license: "public-domain",
            attribution: null,
            allowsRedistribution: true,
            allowsDerivedAi: true,
          },
        })
        .returning({ id: caseLawSources.id });
      sourceId = source?.id ?? panic("Expected synthetic source");
    });
    cleanUp(async () => {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    type IngestWarningDocumentOptions = {
      fulltext: string | undefined;
      sequence: number;
      documentAst?: DocumentAst | EmptyAst;
    };
    const ingest = async ({
      fulltext,
      sequence,
      documentAst = EMPTY_AST,
    }: IngestWarningDocumentOptions) => {
      await processDecision({
        input: plainTextIngestionResult({
          caseNumber: `Warning fixture ${suffix}`,
          sourceDocumentId: "warning-fixture",
          court: "Synthetic court",
          country: "CZE",
          language: "cs",
          fulltext,
          documentAst,
          metadata: {},
          documentUrl: "https://example.test/decision",
          textFields: absentDecisionTextFields(
            TEXT_ABSENCE_REASON.NOT_PUBLISHED,
          ),
          rawHash: `warning-${sequence}`,
        }),
        sourceId,
        scopedDb,
        corpus,
        observationOrder: BigInt(sequence),
        observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)),
      });
      return (
        (await db.query.caseLawDecisions.findFirst({
          where: {
            sourceId: { eq: sourceId },
            sourceDocumentId: { eq: "warning-fixture" },
          },
          columns: { id: true, extractionWarnings: true },
        })) ?? panic("Expected stored decision")
      );
    };

    test("warnings persist, replay, survive metadata refresh, and clear on repaired text", async () => {
      const dirty = await ingest({
        fulltext: "Court \\rtf1\\ansi text",
        sequence: 1,
      });
      expect(dirty.extractionWarnings).toEqual([
        { rule: "rtf-control", count: 1, firstOffsets: [6] },
        { rule: "ast-missing", count: 1, firstOffsets: [] },
      ]);
      expect(
        (await ingest({ fulltext: "Court \\rtf1\\ansi text", sequence: 1 }))
          .extractionWarnings,
      ).toEqual(dirty.extractionWarnings);
      expect(
        (await ingest({ fulltext: undefined, sequence: 2 })).extractionWarnings,
      ).toEqual(dirty.extractionWarnings);
      const pointer = await caseLawPublicReadDb(
        async (tx) => await decisionRecordQuery(tx, dirty.id),
      );
      expect(pointer?.extractionWarnings).toEqual(dirty.extractionWarnings);
      const read = await withRedistributableSubject(
        caseLawPublicReadDb,
        "pages",
        { kind: "id", id: dirty.id },
        async (subject) => await readDecisionHandler({ subject }),
      );
      if (read === null || !("documentPending" in read)) {
        panic("Expected public decision read");
      }
      expect(read.extractionWarnings).toEqual(dirty.extractionWarnings);
      await db.insert(caseLawCitations).values({
        citingDecisionId: dirty.id,
        citationText: "Synthetic citation",
      });
      const passages = await readGatedDecisionCitations({
        caseLawDb: caseLawPublicReadDb,
        decisionId: dirty.id,
        direction: "cites",
        limit: 10,
        cursor: undefined,
      });
      if (passages?.type !== "page") {
        panic("Expected public citation page");
      }
      expect(passages.page.items.at(0)?.extractionWarnings).toEqual(
        dirty.extractionWarnings,
      );
      const fulltext = "The court decided the appeal.";
      // Text alone still lacks structure. Only a valid AST clears ast-missing.
      expect(
        (await ingest({ fulltext, sequence: 3 })).extractionWarnings,
      ).toEqual([{ rule: "ast-missing", count: 1, firstOffsets: [] }]);
      const repairedAst =
        parseDocumentAst({
          version: 1,
          blocks: [
            {
              type: "paragraph",
              id: "p1",
              anchorId: "p1",
              plainText: fulltext,
              inlines: [{ type: "text", text: fulltext }],
            },
          ],
        }) ?? panic("Expected a valid repaired fixture AST");
      expect(
        (await ingest({ fulltext, sequence: 4, documentAst: repairedAst }))
          .extractionWarnings,
      ).toEqual([]);
    });

    test("the database default is a typed empty array", async () => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `Empty fixture ${suffix}`,
          court: "Synthetic court",
          country: "CZE",
          language: "cs",
        })
        .returning({ extractionWarnings: caseLawDecisions.extractionWarnings });
      expect(row?.extractionWarnings).toEqual([]);
    });
  });
}
