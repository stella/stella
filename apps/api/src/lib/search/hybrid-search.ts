import { sql, desc, and, eq, or, isNull } from "drizzle-orm";
import { db } from "@/db";
import { searchDocuments, documentEmbeddings } from "@/db/schema";
import { generateEmbeddingForText } from "./embedding-generator";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export type HybridSearchQuery = {
  query: string;
  mode?: SearchMode;
  workspaceId?: string;
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
    return keywordSearch(query.query, query.workspaceId, limit);
  }

  if (mode === "semantic") {
    return semanticSearch(query.query, query.workspaceId, limit, threshold);
  }

  return hybridSearchCombined(query.query, query.workspaceId, limit, threshold);
};

const keywordSearch = async (
  queryText: string,
  workspaceId?: string,
  limit: number = 10,
): Promise<SearchResult[]> => {
  const tsQuery = queryText
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `${term}:*`)
    .join(" & ");

  const results = await db
    .select({
      id: searchDocuments.id,
      kind: searchDocuments.kind,
      name: searchDocuments.name,
      snippet: sql<string>`ts_headline('english', ${searchDocuments.content}, to_tsquery('english', ${tsQuery}), 'StartSel=<<, StopSel=>>, MaxWords=50, MinWords=20')`,
      rank: sql<number>`ts_rank_cd(${searchDocuments.contentTsvector}, to_tsquery('english', ${tsQuery}))`,
    })
    .from(searchDocuments)
    .where(
      and(
        sql`${searchDocuments.contentTsvector} @@ to_tsquery('english', ${tsQuery})`,
        workspaceId ? eq(searchDocuments.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(desc(sql<number>`ts_rank_cd(${searchDocuments.contentTsvector}, to_tsquery('english', ${tsQuery}))`))
    .limit(limit);

  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    snippet: r.snippet,
    rank: r.rank,
  }));
};

const semanticSearch = async (
  queryText: string,
  workspaceId?: string,
  limit: number = 10,
  threshold: number = 0.7,
): Promise<SearchResult[]> => {
  const queryEmbedding = await generateEmbeddingForText(queryText);
  if (!queryEmbedding) {
    return [];
  }

  const similarity = sql<number>`1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(queryEmbedding))})`;

  const results = await db
    .select({
      id: documentEmbeddings.entityId,
      chunkText: documentEmbeddings.chunkText,
      similarity,
      metadata: documentEmbeddings.metadata,
    })
    .from(documentEmbeddings)
    .where(sql`${similarity} > ${threshold}`)
    .orderBy(desc(similarity))
    .limit(limit);

  const entityIds = results.map((r) => r.id);
  const entitySearchResults = await db
    .select({
      id: searchDocuments.id,
      kind: searchDocuments.kind,
      name: searchDocuments.name,
    })
    .from(searchDocuments)
    .where(
      sql`${searchDocuments.id} IN ${entityIds}`,
    );

  const entityMap = new Map(entitySearchResults.map((e) => [e.id, e]));

  return results.map((r) => {
    const entity = entityMap.get(r.id);
    return {
      id: r.id,
      kind: entity?.kind ?? "unknown",
      name: entity?.name ?? "Unknown",
      snippet: r.chunkText,
      rank: r.similarity,
      similarity: r.similarity,
    };
  });
};

const hybridSearchCombined = async (
  queryText: string,
  workspaceId?: string,
  limit: number = 10,
  threshold: number = 0.7,
): Promise<SearchResult[]> => {
  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(queryText, workspaceId, limit),
    semanticSearch(queryText, workspaceId, limit, threshold),
  ]);

  const combined = new Map<string, SearchResult>();

  for (const result of keywordResults) {
    const existing = combined.get(result.id);
    if (existing) {
      existing.rank += result.rank;
      existing.similarity = result.similarity ?? existing.similarity;
    } else {
      combined.set(result.id, { ...result });
    }
  }

  for (const result of semanticResults) {
    const existing = combined.get(result.id);
    if (existing) {
      existing.rank += result.rank;
      existing.similarity = result.similarity;
    } else {
      combined.set(result.id, { ...result });
    }
  }

  return Array.from(combined.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
};
