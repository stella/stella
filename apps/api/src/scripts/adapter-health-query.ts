import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSearchDocuments,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

const FIELD_COLUMN_MAP = {
  ecli: caseLawDecisions.ecli,
  decision_date: caseLawDecisions.decisionDate,
  decision_type: caseLawDecisions.decisionType,
  fulltext: caseLawDecisions.fulltext,
  source_url: caseLawDecisions.sourceUrl,
  document_url: caseLawDecisions.documentUrl,
  source_hash: caseLawDecisions.sourceHash,
} as const;

export const CHECKED_FIELDS = [
  "ecli",
  "decision_date",
  "decision_type",
  "fulltext",
  "source_url",
  "document_url",
  "source_hash",
] as const satisfies readonly (keyof typeof FIELD_COLUMN_MAP)[];

type MissingCheckedField = Exclude<
  keyof typeof FIELD_COLUMN_MAP,
  (typeof CHECKED_FIELDS)[number]
>;

true satisfies MissingCheckedField extends never ? true : never;

export const ADAPTER_HEALTH_DECISION_PAGE_SIZE = 5000;

type PageOptions = {
  sourceId: SafeId<"caseLawSource">;
  sinceDate: Date;
  afterId: string | null;
  limit: number;
};

/** The source page uses (source_id, id); each lateral read uses a decision key. */
export const adapterHealthPageStatement = ({
  sourceId,
  sinceDate,
  afterId,
  limit,
}: PageOptions) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ADAPTER_HEALTH_DECISION_PAGE_SIZE
  ) {
    panic("Adapter health page limit is out of range.");
  }

  const selectedFields = sql.join(
    CHECKED_FIELDS.map(
      (field) => sql`${FIELD_COLUMN_MAP[field]} AS ${sql.identifier(field)}`,
    ),
    sql`, `,
  );
  const fieldCounts = sql.join(
    CHECKED_FIELDS.map((field) => {
      const column = sql`page.${sql.identifier(field)}`;
      return sql`count(*) FILTER (WHERE ${column} IS NOT NULL AND ${column}::text <> '')::text AS ${sql.identifier(field)}`;
    }),
    sql`, `,
  );
  const after =
    afterId === null
      ? sql``
      : sql`AND ${caseLawDecisions.id} > ${afterId}::uuid`;

  // sql-perf-allow: bounded by materialized decision_page LIMIT 5000 maximum and indexed per-decision citation reads
  return sql`
    WITH decision_page AS MATERIALIZED (
      SELECT ${caseLawDecisions.id} AS id,
             ${caseLawDecisions.createdAt} AS created_at,
             ${selectedFields}
        FROM ${caseLawDecisions}
       WHERE ${caseLawDecisions.sourceId} = ${sourceId}
         ${after}
       ORDER BY ${caseLawDecisions.id}
       LIMIT ${limit}
    )
    SELECT count(*)::text AS total,
           max(page.id::text) AS last_id,
           count(*) FILTER (WHERE page.created_at > ${sinceDate}::timestamptz)::text AS inserted,
           count(*) FILTER (WHERE search_document.decision_id IS NOT NULL)::text AS indexed,
           coalesce(sum(citation_counts.total), 0)::text AS citation_total,
           coalesce(sum(citation_counts.resolved), 0)::text AS citation_resolved,
           ${fieldCounts}
      FROM decision_page page
      LEFT JOIN LATERAL (
        SELECT ${caseLawSearchDocuments.decisionId} AS decision_id
          FROM ${caseLawSearchDocuments}
         WHERE ${caseLawSearchDocuments.decisionId} = page.id
         LIMIT 1
      ) search_document ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE ${caseLawCitations.citedDecisionId} IS NOT NULL) AS resolved
          FROM ${caseLawCitations}
         WHERE ${caseLawCitations.citingDecisionId} = page.id
      ) citation_counts ON true
  `;
};

type MetricsDb = Pick<typeof rootDb, "transaction">;

type MetricsOptions = {
  db: MetricsDb;
  sourceId: SafeId<"caseLawSource">;
  sinceDate: Date;
  pageSize?: number;
};

const readCount = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    return panic(`Adapter health count ${key} is invalid.`);
  }
  return number;
};

const pageRow = (result: unknown): Record<string, unknown> => {
  const rows = isRecord(result) ? result["rows"] : result;
  if (!Array.isArray(rows)) {
    return panic("Adapter health page returned no rows array.");
  }
  const row: unknown = rows.at(0);
  return isRecord(row)
    ? row
    : panic("Adapter health page returned no aggregate.");
};

/** Each statement scans one bounded source page and makes indexed point reads. */
export const readAdapterHealthMetrics = async ({
  db,
  sourceId,
  sinceDate,
  pageSize = ADAPTER_HEALTH_DECISION_PAGE_SIZE,
}: MetricsOptions) => {
  let total = 0;
  let inserted = 0;
  let indexed = 0;
  let citationTotal = 0;
  let citationResolved = 0;
  const fields = new Map<(typeof CHECKED_FIELDS)[number], number>(
    CHECKED_FIELDS.map((field) => [field, 0]),
  );

  // Each continuation reduces one indexed page before requesting the next.
  const readPage = async (afterId: string | null): Promise<void> => {
    const statement = adapterHealthPageStatement({
      sourceId,
      sinceDate,
      afterId,
      limit: pageSize,
    });
    const result = await db.transaction(
      async (tx) => await tx.execute(statement),
    );
    const row = pageRow(result);
    const pageTotal = readCount(row, "total");
    if (pageTotal === 0) {
      return;
    }
    total += pageTotal;
    inserted += readCount(row, "inserted");
    indexed += readCount(row, "indexed");
    citationTotal += readCount(row, "citation_total");
    citationResolved += readCount(row, "citation_resolved");
    for (const field of CHECKED_FIELDS) {
      fields.set(field, (fields.get(field) ?? 0) + readCount(row, field));
    }
    const lastId = row["last_id"];
    if (typeof lastId !== "string" || lastId === afterId) {
      panic("Adapter health page cursor did not advance.");
    }
    if (pageTotal < pageSize) {
      return;
    }
    await readPage(lastId);
  };
  await readPage(null);

  return { total, inserted, indexed, citationTotal, citationResolved, fields };
};
