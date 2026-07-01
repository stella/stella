import { eq, desc, cosineDistance, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { documentEmbeddings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type VectorStoreConfig = {
  dimensions?: number;
  lists?: number;
  efConstruction?: number;
  m?: number;
};

export type EmbeddingDocument = {
  entityId: SafeId<"entity">;
  chunkIndex: number;
  chunkText: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

export type SimilaritySearchResult = {
  entityId: SafeId<"entity">;
  chunkIndex: number;
  chunkText: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export const storeEmbeddings = async (
  embeddings: EmbeddingDocument[],
): Promise<void> => {
  if (embedments.length === 0) {
    return;
  }

  const values = embeddings.map((e) => ({
    entityId: e.entityId,
    chunkIndex: e.chunkIndex,
    chunkText: e.chunkText,
    embedding: e.embedding,
    metadata: e.metadata ?? {},
  }));

  await rootDb.insert(documentEmbeddings).values(values);
};

export const findSimilarChunks = async (
  entityId: SafeId<"entity">,
  embedding: number[],
  topK: number = 10,
  threshold: number = 0.7,
): Promise<SimilaritySearchResult[]> => {
  const similarity = sql<number>`1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(embedding))})`;

  const results = await rootDb
    .select({
      entityId: documentEmbeddings.entityId,
      chunkIndex: documentEmbeddings.chunkIndex,
      chunkText: documentEmbeddings.chunkText,
      similarity,
      metadata: documentEmbeddings.metadata,
    })
    .from(documentEmbeddings)
    .where(
      sql`${eq(documentEmbeddings.entityId, entityId)} AND ${similarity} > ${threshold}`,
    )
    .orderBy(desc(similarity))
    .limit(topK);

  return results.map((r) => ({
    entityId: r.entityId,
    chunkIndex: r.chunkIndex,
    chunkText: r.chunkText,
    similarity: r.similarity,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
};

export const findRelatedChunks = async (
  embedding: number[],
  topK: number = 10,
  threshold: number = 0.7,
): Promise<SimilaritySearchResult[]> => {
  const similarity = sql<number>`1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(embedding))})`;

  const results = await rootDb
    .select({
      entityId: documentEmbeddings.entityId,
      chunkIndex: documentEmbeddings.chunkIndex,
      chunkText: documentEmbeddings.chunkText,
      similarity,
      metadata: documentEmbeddings.metadata,
    })
    .from(documentEmbeddings)
    .where(sql`${similarity} > ${threshold}`)
    .orderBy(desc(similarity))
    .limit(topK);

  return results.map((r) => ({
    entityId: r.entityId,
    chunkIndex: r.chunkIndex,
    chunkText: r.chunkText,
    similarity: r.similarity,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
};

export const deleteEntityEmbeddings = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
  await rootDb
    .delete(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));
};

export const countEntityEmbeddings = async (
  entityId: SafeId<"entity">,
): Promise<number> => {
  const result = await rootDb
    .select({ count: sql<number>`count(*)` })
    .from(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));

  return result.at(0)?.count ?? 0;
};
