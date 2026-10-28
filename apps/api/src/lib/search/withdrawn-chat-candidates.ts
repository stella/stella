import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { GLOBAL_SEARCH_RANK_WORK_LIMIT_CODE } from "@stll/api-contract/search";

import type { Transaction } from "@/api/db/root";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

import {
  chatSearchVectorSql,
  extractMessageSearchText,
} from "./chat-search-text";
import { TS_HEADLINE_CONFIG } from "./highlight";
import { globalSearchCursorSql } from "./pagination";
import type { GlobalSearchCursor } from "./pagination";
import { buildSearchTsQuery } from "./query";

export type ChatSearchCandidateRow = Record<string, unknown> & {
  id: string;
  score: number;
};
type ReadChatCandidateBatchesOptions = {
  readBatch: (
    cursor: GlobalSearchCursor | null,
  ) => Promise<ChatSearchCandidateRow[]>;
};

/** Removing source text changes relevance: the public cursor must use the complete admitted ranking input. */
export const readChatCandidateBatches = async ({
  readBatch,
}: ReadChatCandidateBatchesOptions) => {
  const rows: ChatSearchCandidateRow[] = [];
  let cursor: GlobalSearchCursor | null = null;
  let bytes = 0;
  for (let round = 0; round < LIMITS.searchChatCandidateBatchesMax; round++) {
    const batch = await readBatch(cursor);
    const page = batch.slice(0, LIMITS.searchChatCandidateThreadsMax);
    bytes += Buffer.byteLength(JSON.stringify(page));
    const sourceOverflow = page.some((row) => {
      const messages = row["source_messages"];
      return (
        Array.isArray(messages) &&
        messages.some(
          (message: unknown) =>
            isRecord(message) && message["overflow"] === true,
        )
      );
    });
    if (sourceOverflow || bytes > LIMITS.searchChatCandidateBytesMax) {
      break;
    }
    rows.push(...page);
    if (batch.length <= LIMITS.searchChatCandidateThreadsMax) {
      return Result.ok(rows);
    }
    const last =
      page.at(-1) ?? panic("A full candidate batch must have a final row");
    cursor = {
      score: last.score,
      id: `chat:${last.id}`,
      seen: 0,
    };
  }
  return Result.err(
    new HandlerError({
      code: GLOBAL_SEARCH_RANK_WORK_LIMIT_CODE,
      status: 422,
      message:
        "Refine the search to rank its results within the search work limit",
    }),
  );
};
type ProjectChatCandidatesOptions = {
  database: Pick<Transaction, "execute">;
  rows: ChatSearchCandidateRow[];
  query: string;
  cursor: GlobalSearchCursor | null;
  limit: number;
};

/** Ranks and previews only admitted source text from a bounded candidate window. */
export const projectChatSearchCandidates = async ({
  database,
  rows,
  query,
  cursor,
  limit,
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
      id: row.id,
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
    ), ranked AS (
    SELECT id,
      ${query.trim() === "" ? sql`extract(epoch from updated_at)::float8 * 1000` : sql`ts_rank(tsv, ${tsQuery})::float8`} AS score,
      ${query.trim() === "" ? sql`NULL::text` : sql`ts_headline('public.stella_unaccent'::regconfig, left(title || ' ' || text, ${LIMITS.searchHeadlineDocumentMaxChars}), ${tsQuery}, ${TS_HEADLINE_CONFIG})`} AS headline
    FROM source
    WHERE ${query.trim() === "" ? sql`true` : sql`tsv @@ ${tsQuery}`}
    )
    SELECT id, score, headline FROM ranked
    WHERE TRUE
      ${globalSearchCursorSql({ cursor, score: sql`score`, id: sql`'chat:' || id` })}
    ORDER BY score DESC, id COLLATE "C" DESC
    LIMIT ${limit}
  `);
  const byId = new Map(ranked.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const safe = byId.get(row.id);
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
