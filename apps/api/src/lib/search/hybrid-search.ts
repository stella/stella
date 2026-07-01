import { sql, cosineDistance } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { documentEmbeddings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { generateEmbeddingForText } from "./embedding-generator";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export type HybridSearchQuery = {
  query: string;
  mode?: SearchMode;
  workspaceId?: SafeId<"workspace">;
  limit?: number;
  threshold?: number;
};

export type SearchResult = {
  id: string;
  kind: string;
  name: string;
  snippet: string | null;
  rank: number;
  similarity?: number;
};

export const hybridSearch = async (
  query: HybridSearchQuery,
): Promise<SearchResult[]> => {
  const mode = query.mode ?? "hybrid";
  const limit = query.limit ?? 10;
  const threshold = query.threshold ?? 0.7;

  if (mode === "keyword") {
    return await keywordSearch(query.query, query.workspaceId, limit);
  }

  if (mode === "semantic") {
    return await semanticSearch(query.query, limit, threshold);
  }

  return await hybridSearchCombined(
    query.query,
    query.workspaceId,
    limit,
    threshold,
  );
};

const keywordSearch = async (
  queryText: string,
  workspaceId?: SafeId<"workspace">,
  limit: number = 10,
): Promise<SearchResult[]> => {
  const tsQuery = queryText
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `${term}:*`)
    .join(" & ");

  const workspaceFilter = workspaceId
    ? sql`AND sd.workspace_id = ${workspaceId}`
    : sql``;

  const results = await rootDb.execute<{
    entity_id: string;
    kind: string;
    name: string;
    snippet: string;
    rank: number;
  }>(sql`
    SELECT
      sd.entity_id,
      sd.kind,
      sd.name,
      ts_headline(
        'english',
        sd.title || ' ' || left(sd.searchable_text, 2000),
        to_tsquery('english', ${tsQuery}),
        'StartSel=<<, StopSel=>>, MaxWords=50, MinWords=20'
      ) AS snippet,
      ts_rank_cd(sd.tsv, to_tsquery('english', ${tsQuery}))::float8 AS rank
    FROM search_documents sd
    WHERE sd.tsv @@ to_tsquery('english', ${tsQuery})
      ${workspaceFilter}
    ORDER BY score DESC, sd.entity_id DESC
    LIMIT ${limit}
  `);

  return results.map((r) => ({
    id: r.entity_id,
    kind: r.kind,
    name: r.name,
    snippet: r.snippet,
    rank: r.rank,
  }));
};

const semanticSearch = async (
  queryText: string,
  limit: number = 10,
  threshold: number = 0.7,
): Promise<SearchResult[]> => {
  const queryEmbedding = await generateEmbeddingForText(queryText);
  if (!queryEmbedding) {
    return [];
  }

  const results = await rootDb.execute<{
    entity_id: string;
    chunk_text: string;
    similarity: number;
  }>(sql`
    SELECT
      de.entity_id,
      de.chunk_text,
      1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(queryEmbedding))}) AS similarity
    FROM document_embeddings de
    WHERE 1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(queryEmbedding))}) > ${threshold}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  const entityIds = results.map((r) => r.entity_id);
  if (entityIds.length === 0) {
    return [];
  }

  const entitySearchResults = await rootDb.execute<{
    entity_id: string;
    kind: string;
    name: string;
  }>(sql`
    SELECT sd.entity_id, sd.kind, sd.name
    FROM search_documents sd
    WHERE sd.entity_id = ANY(${entityIds}::uuid[])
  `);

  const entityMap = new Map(entitySearchResults.map((e) => [e.entity_id, e]));

  return results.map((r) => {
    const entity = entityMap.get(r.entity_id);
    return {
      id: r.entity_id,
      kind: entity?.kind ?? "unknown",
      name: entity?.name ?? "Unknown",
      snippet: r.chunk_text,
      rank: r.similarity,
      similarity: r.similarity,
    };
  });
};

const hybridSearchCombined = async (
  queryText: string,
  workspaceId?: SafeId<"workspace">,
  limit: number = 10,
  threshold: number = 0.7,
): Promise<SearchResult[]> => {
  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(queryText, workspaceId, limit),
    semanticSearch(queryText, limit, threshold),
  ]);

  const combined = new Map<string, SearchResult>();

  for (const result of keywordResults) {
    const existing = combined.get(result.id);
    if (existing) {
      existing.rank += result.rank;
      const sim = result.similarity ?? existing.similarity;
      if (sim !== undefined) {
        existing.similarity = sim;
      }
    } else {
      combined.set(result.id, { ...result });
    }
  }

  for (const result of semanticResults) {
    const existing = combined.get(result.id);
    if (existing) {
      existing.rank += result.rank;
      if (result.similarity !== undefined) {
        existing.similarity = result.similarity;
      }
    } else {
      combined.set(result.id, { ...result });
    }
  }

  return Array.from(combined.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
};
