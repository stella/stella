import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  remainingDocumentCandidateQuery,
  remainingDocumentOrder,
  remainingDocumentPredicate,
  pendingDocumentPredicate,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { RemainingDocumentCursor } from "@/api/lib/legal-search/sk-document-backfill";
import {
  DOCUMENT_OUTSTANDING_DATE_INDEX,
  DOCUMENT_OUTSTANDING_INDEX,
} from "@/api/lib/legal-search/sk-document-outstanding-index";
import {
  DOCUMENT_SCAN_PAGE_LIMIT,
  DOCUMENT_SCAN_ROW_BUDGET,
} from "@/api/lib/legal-search/sk-document-remaining-scan";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const sourceId = toSafeId<"caseLawSource">(
  "00000000-0000-7000-8000-000000000001",
);
const ROWS = 20_000;
const idAt = (n: number) =>
  toSafeId<"caseLawDecision">(
    `00000000-0000-7000-8001-${String(n).padStart(12, "0")}`,
  );

const planNodes = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("Candidate plan children are malformed");
  }
  return [node, ...children.flatMap(planNodes)];
};

const examinedRows = (node: Record<string, unknown>) => {
  const actual = node["Actual Rows"];
  const removed = node["Rows Removed by Filter"] ?? 0;
  const loops = node["Actual Loops"];
  if (
    typeof actual !== "number" ||
    typeof removed !== "number" ||
    typeof loops !== "number"
  ) {
    return panic("Candidate plan lacks actual row counts");
  }
  return (actual + removed) * loops;
};

test("outstanding candidate pages bound cooldown-heavy first, middle and NULL-tail scans", async () => {
  const client = new PGlite();
  try {
    // Only the queue's table is needed; derive column types from its owner.
    // Avoid the full corpus/auth snapshot for this isolated physical plan.
    const columns = getTableConfig(caseLawDecisions).columns.map(
      (column) => `"${column.name}" ${column.getSQLType()}`,
    );
    await client.exec(
      `CREATE TABLE case_law_decisions (${columns.join(", ")})`,
    );
    for (const index of [
      DOCUMENT_OUTSTANDING_INDEX,
      DOCUMENT_OUTSTANDING_DATE_INDEX,
    ]) {
      await client.exec(
        index.createSql.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX"),
      );
    }
    const db = drizzle({ client });
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, decision_date, document_url, document_fetch_attempts,
         document_fetch_attempted_at)
      SELECT ('00000000-0000-7000-8001-' || lpad(i::text, 12, '0'))::uuid,
        ${sourceId}::uuid,
        CASE WHEN i > 18000 THEN NULL ELSE DATE '2030-01-01' - (i / 10) END,
        'https://example.test/' || i || '.pdf', 1,
        CASE WHEN i = ${ROWS} THEN NULL ELSE TIMESTAMPTZ '2099-01-01' END
      FROM generate_series(1, ${ROWS}) AS i
    `);
    await client.exec("VACUUM (ANALYZE) case_law_decisions");
    const cursors: (RemainingDocumentCursor | undefined)[] = [
      undefined,
      { decisionDate: "2027-04-07", id: idAt(10_000) },
      { decisionDate: null, id: idAt(18_500) },
    ];
    await db.transaction(async (rootTx) => {
      const tx = asTestRaw<Transaction>(rootTx);
      for (const after of cursors) {
        const query = remainingDocumentCandidateQuery({
          tx,
          sourceId,
          limit: DOCUMENT_SCAN_ROW_BUDGET,
          ...(after === undefined ? {} : { after }),
        });
        const plan = explainRoot(
          await tx.execute(
            sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query.getSQL()}`,
          ),
        );
        const scans = scanOccurrences(plan);
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(scan.nodeType).toBe("Index Scan");
          expect(scan.index).toBe(DOCUMENT_OUTSTANDING_DATE_INDEX.name);
          expect(scan.indexCond).toContain("source_id");
          expect(scan.filter).toBeNull();
          expect(scan.limitAbove).toBe(true);
          expect(scan.limitRows).toBeLessThanOrEqual(DOCUMENT_SCAN_PAGE_LIMIT);
        }
        const nodes = planNodes(plan);
        const scanNodes = nodes.filter(
          (node) => node["Relation Name"] === "case_law_decisions",
        );
        const visited = scanNodes.reduce(
          (sum, node) => sum + examinedRows(node),
          0,
        );
        expect(visited).toBeLessThanOrEqual(DOCUMENT_SCAN_ROW_BUDGET);
        expect(plan["Total Cost"]).toBeLessThan(10_000);
        process.stdout.write(
          `Outstanding candidates ${after?.decisionDate ?? (after ? "NULL-tail" : "first")}: visited=${visited}, cost=${String(plan["Total Cost"])}\n`,
        );
        for (const node of nodes.filter(
          (candidate) => candidate["Node Type"] === "Sort",
        )) {
          const child =
            planNodes(node).at(1) ?? panic("Candidate sort has no input");
          expect(examinedRows(child)).toBeLessThanOrEqual(
            DOCUMENT_SCAN_ROW_BUDGET,
          );
        }
        const rows = await query;
        expect(rows).toHaveLength(DOCUMENT_SCAN_PAGE_LIMIT);
        expect(rows.every(({ ready }) => !ready)).toBe(true);
      }
      // A readiness WHERE with LIMIT looks bounded in estimated plans but
      // walks the entire cooled prefix before finding the oldest due row.
      const wrong = tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            remainingDocumentPredicate,
          ),
        )
        .orderBy(...remainingDocumentOrder)
        .limit(DOCUMENT_SCAN_PAGE_LIMIT);
      expect(await wrong).toEqual([{ id: idAt(ROWS) }]);
      const wrongPlan = explainRoot(
        await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${wrong.getSQL()}`),
      );
      const wrongScans = planNodes(wrongPlan).filter(
        (node) => node["Relation Name"] === "case_law_decisions",
      );
      expect(
        wrongScans.reduce((sum, node) => sum + examinedRows(node), 0),
      ).toBeGreaterThan(DOCUMENT_SCAN_ROW_BUDGET);
      // Even without readiness filtering, a mixed-order OR can discard
      // every earlier date while restarting at the source's index prefix.
      const wrongCursor = tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            pendingDocumentPredicate,
            sql`(${caseLawDecisions.decisionDate} < '2027-04-07'::date
            OR ${caseLawDecisions.decisionDate} IS NULL
            OR (${caseLawDecisions.decisionDate} = '2027-04-07'::date
              AND ${caseLawDecisions.id} > ${idAt(10_000)}::uuid))`,
          ),
        )
        .orderBy(...remainingDocumentOrder)
        .limit(DOCUMENT_SCAN_PAGE_LIMIT);
      const wrongCursorPlan = explainRoot(
        await tx.execute(
          sql`EXPLAIN (ANALYZE, FORMAT JSON) ${wrongCursor.getSQL()}`,
        ),
      );
      const wrongCursorScans = planNodes(wrongCursorPlan).filter(
        (node) => node["Relation Name"] === "case_law_decisions",
      );
      expect(
        wrongCursorScans.reduce((sum, node) => sum + examinedRows(node), 0),
      ).toBeGreaterThan(DOCUMENT_SCAN_ROW_BUDGET);
    });
  } finally {
    await client.close();
  }
}, 120_000);
