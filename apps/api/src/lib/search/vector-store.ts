import { eq, desc, cosineDistance, sql, and } from "drizzle-orm";
import { db } from "@/db";
import { documentEmbeddings } from "@/db/schema";

export type VectorStoreConfig = {
  dimensions?: number;
  lists?: number;
  efConstruction?: number;
  m?: number;
};

export type EmbeddingDocument = {
  entityId: string;
  chunkIndex: number;
  chunkText: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

export type SimilaritySearchResult = {
  entityId: string;
  chunkIndex: number;
  chunkText: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export const storeEmbeddings = async (
  embeddings: EmbeddingDocument[],
): Promise<void> => {
  if (embeddings.length === 0) return;

  const values = embeddings.map((e) => ({
    entityId: e.entityId,
    chunkIndex: e.chunkIndex,
    chunkText: e.chunkText,
    embedding: JSON.stringify(e.embedding),
    metadata: e.metadata ?? {},
  }));

  await db.insert(documentEmbeddings).values(values);
};

export const findSimilarChunks = async (
  entityId: string,
  embedding: number[],
  topK: number = 10,
  threshold: number = 0.7,
): Promise<SimilaritySearchResult[]> => {
  const similarity = sql<number>`1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(embedding))})`;

  const results = await db
    .select({
      entityId: documentEmbeddings.entityId,
      chunkIndex: documentEmbeddings.chunkIndex,
      chunkText: documentEmbeddings.chunkText,
      similarity,
      metadata: documentEmbeddings.metadata,
    })
    .from(documentEmbeddings)
    .where(
      and(
        eq(documentEmbeddings.entityId, entityId),
        sql`${similarity} > ${threshold}`,
      ),
    )
    .orderBy(desc(similarity))
    .limit(topK);

  return results.map((r) => ({
    entityId: r.entityId,
    chunkIndex: r.chunkIndex,
    chunkText: r.chunkText,
    similarity: r.similarity,
    metadata: r.metadata as Record<string, unknown>,
  }));
};

export const findRelatedChunks = async (
  embedding: number[],
  topK: number = 10,
  threshold: number = 0.7,
): Promise<SimilaritySearchResult[]> => {
  const similarity = sql<number>`1 - (${cosineDistance(documentEmbeddings.embedding, JSON.stringify(embedding))})`;

  const results = await db
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
    metadata: r.metadata as Record<string, unknown>,
  }));
};

export const deleteEntityEmbeddings = async (entityId: string): Promise<void> => {
  await db
    .delete(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));
};

export const countEntityEmbeddings = async (entityId: string): Promise<number> => {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));

  return result.at(0)?.count ?? 0;
};
