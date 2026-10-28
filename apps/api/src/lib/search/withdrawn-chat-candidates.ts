import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

import {
  chatSearchVectorSql,
  extractMessageSearchText,
} from "./chat-search-text";
import { TS_HEADLINE_CONFIG } from "./highlight";
import { buildSearchTsQuery } from "./query";

type CandidateRow = Record<string, unknown>;
type ProjectChatCandidatesOptions = {
  database: Pick<Transaction, "execute">;
  rows: CandidateRow[];
  query: string;
};

/** Ranks and previews only admitted source text from a bounded candidate window. */
export const projectChatSearchCandidates = async ({
  database,
  rows,
  query,
}: ProjectChatCandidatesOptions) => {
  if (rows.length === 0) {
    return [];
  }
  const projection = await readWithdrawnCopyProjection({ values: rows });
  const admitted = rows.map((row) => {
    const subject =
      typeof row["subject_decision_id"] === "string"
        ? row["subject_decision_id"]
        : null;
    const marker = projection.marker(
      [row["title"], row["source_messages"]],
      subject,
    );
    const title =
      marker === null || row["title_source"] === "user"
        ? String(row["title"])
        : "";
    const messages = Array.isArray(row["source_messages"])
      ? row["source_messages"]
      : [];
    const text = messages
      .flatMap((message: unknown) => {
        if (!isRecord(message)) {
          return [];
        }
        if (
          message["role"] !== "user" &&
          projection.marker(message["content"], subject) !== null
        ) {
          return [];
        }
        return [extractMessageSearchText(message["content"])];
      })
      .join(" ");
    return {
      id: String(row["id"]),
      title,
      text,
      updated_at: row["updated_at"],
    };
  });
  const tsQuery = buildSearchTsQuery(query);
  const ranked = await database.execute<{
    id: string;
    score: number;
    headline: string | null;
  }>(sql`
    WITH source AS (
      SELECT *, ${chatSearchVectorSql(sql`title || ' ' || text`)} AS tsv
      FROM jsonb_to_recordset(${JSON.stringify(admitted)}::text::jsonb)
        AS r(id text, title text, text text, updated_at timestamptz)
    )
    SELECT id,
      ${query.trim() === "" ? sql`extract(epoch from updated_at)::float8 * 1000` : sql`ts_rank(tsv, ${tsQuery})::float8`} AS score,
      ${query.trim() === "" ? sql`NULL::text` : sql`ts_headline('public.stella_unaccent'::regconfig, left(title || ' ' || text, ${LIMITS.searchHeadlineDocumentMaxChars}), ${tsQuery}, ${TS_HEADLINE_CONFIG})`} AS headline
    FROM source
    WHERE ${query.trim() === "" ? sql`true` : sql`tsv @@ ${tsQuery}`}
  `);
  const byId = new Map(ranked.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const safe = byId.get(String(row["id"]));
    if (safe === undefined) {
      return [];
    }
    const subject =
      typeof row["subject_decision_id"] === "string"
        ? row["subject_decision_id"]
        : null;
    const label = projection.marker(
      [row["title"], row["source_messages"]],
      subject,
    );
    return [
      {
        ...row,
        title:
          row["title_source"] === "user"
            ? row["title"]
            : (label ?? row["title"]),
        score: safe.score,
        headline: safe.headline,
      },
    ];
  });
};
