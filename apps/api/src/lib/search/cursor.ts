/**
 * Score-based keyset cursor for full-text search pagination.
 * Encodes a (score, id) tuple as base64; used by both entity
 * search and case law search.
 */
export const decodeCursor = (
  cursor: string,
): { score: number; id: string } | null => {
  const decoded = Buffer.from(cursor, "base64").toString();
  const [scoreStr, id] = decoded.split(":");
  const score = Number(scoreStr);
  if (!Number.isFinite(score) || !id) {
    return null;
  }

  return { score, id };
};

export const encodeCursor = (score: number, id: string): string =>
  Buffer.from(`${score}:${id}`).toString("base64");
