import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { publishedCaseLawDecisions } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  readDecisionTextGroup,
  readPassageSourcePointers,
} from "./citation-passages";

const changes = {
  revision: sql`UPDATE case_law_published_decisions SET sections = '[]'::jsonb`,
  country: sql`UPDATE case_law_published_decisions SET country = 'SVK'`,
  publication: sql`DELETE FROM case_law_published_decisions`,
  redistribution: sql`UPDATE case_law_sources SET descriptor = '{"allowsRedistribution":false,"allowsDerivedAi":true}'::jsonb`,
  derivedAi: sql`UPDATE case_law_sources SET descriptor = '{"allowsRedistribution":true,"allowsDerivedAi":false}'::jsonb`,
  tombstone: sql`SELECT 1`,
};
for (const [fence, change] of Object.entries(changes)) {
  for (const mode of ["cached", "windowed"] as const) {
    test(`${fence} fence prevents citation text from a ${mode} read`, async () => {
      const client = await PGlite.create();
      const db = drizzle({ client });
      try {
        const columns = [
          publishedCaseLawDecisions.id,
          publishedCaseLawDecisions.sourceId,
          publishedCaseLawDecisions.country,
          publishedCaseLawDecisions.updatedAt,
          publishedCaseLawDecisions.contentHash,
          publishedCaseLawDecisions.astS3Key,
          publishedCaseLawDecisions.documentAst,
          publishedCaseLawDecisions.sections,
          publishedCaseLawDecisions.extractionWarnings,
        ];
        await db.execute(
          sql`CREATE TABLE case_law_published_decisions (${sql.join(
            columns.map(
              (column) =>
                sql`${sql.identifier(column.name)} ${sql.raw(column.getSQLType())}`,
            ),
            sql`, `,
          )})`,
        );
        await db.execute(
          sql`CREATE TABLE case_law_sources (id uuid, descriptor jsonb)`,
        );
        const sourceId = createSafeId<"caseLawSource">();
        const id = createSafeId<"caseLawDecision">();
        const ast = {
          version: 1,
          source: { system: "test", documentId: id, webUrl: "", printUrl: "" },
          metadata: {
            caseNumber: "Synthetic 1",
            court: "Synthetic court",
            ecli: null,
            decisionDate: null,
            decisionType: null,
            keywords: [],
            statutes: [],
          },
          blocks: [
            {
              id: "p1",
              anchorId: "p1",
              type: "paragraph",
              inlines: [{ type: "text", text: "Synthetic citation text." }],
              plainText: "Synthetic citation text.",
            },
          ],
        } satisfies DocumentAst;
        await db.execute(
          sql`INSERT INTO case_law_sources VALUES (${sourceId}, NULL)`,
        );
        await db.execute(sql`INSERT INTO case_law_published_decisions (id, source_id, country, updated_at, content_hash, ast_s3_key, document_ast, sections, extraction_warnings)
          VALUES (${id}, ${sourceId}, 'CZE', '2026-01-01T00:00:00.123456Z', 'hash', ${`synthetic/${id}`}, ${JSON.stringify(ast)}::text::jsonb, '[{"index":0,"text":"Synthetic citation text.","type":"argumentation","title":null}]'::jsonb, '[]'::jsonb)`);
        const tx = asTestRaw<CaseLawPublicReadTransaction>(db);
        let admissionReads = 0;
        const mutateAt = mode === "cached" ? 1 : 4;
        let phase: "warm" | "probe" = "warm";
        const caseLawDb = Object.assign(
          async <T>(
            fn: (value: CaseLawPublicReadTransaction) => Promise<T>,
          ) => {
            admissionReads += 1;
            if (
              phase === "probe" &&
              admissionReads === mutateAt &&
              fence !== "tombstone"
            ) {
              await db.execute(change);
            }
            return await fn(tx);
          },
          caseLawPublicReadDb,
        );
        const pointers = await readPassageSourcePointers(
          tx,
          [id],
          ["CZE", "SVK"],
        );
        expect(pointers).toHaveLength(1);
        if (mode === "cached") {
          const warm = await readDecisionTextGroup({
            caseLawDb,
            pointers,
            countries: ["CZE", "SVK"],
            readTombstones: async () => new Set(),
          });
          expect(warm.get(id)).toMatchObject({ type: "source", text: { ast } });
        }
        admissionReads = 0;
        phase = "probe";
        let reads = 0;
        const result = await readDecisionTextGroup({
          caseLawDb,
          pointers,
          countries: ["CZE", "SVK"],
          readTombstones: async () => {
            reads += 1;

            return fence === "tombstone" && reads >= (mode === "cached" ? 1 : 2)
              ? new Set([`synthetic/${id}`])
              : new Set<string>();
          },
        });
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(result.get(id)).toEqual({ type: "unavailable" });
      } finally {
        await client.close();
      }
    });
  }
}
