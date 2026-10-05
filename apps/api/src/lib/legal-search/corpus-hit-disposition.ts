import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";

type CorpusHitDisposition =
  | { type: "valid"; id: string }
  | {
      type: "malformed";
      reason: "missing_document_id" | "invalid_document_id";
    };

/** The corpus-specific identity reader decides validity in every scan mode. */
export const classifyCorpusHit = (
  hit: CorpusIndexHit,
  extractId: (hit: CorpusIndexHit) => string | null,
): CorpusHitDisposition => {
  const id = extractId(hit);
  if (id !== null) {
    return { type: "valid", id };
  }
  return {
    type: "malformed",
    reason:
      hit["document_id"] === undefined || hit["document_id"] === null
        ? "missing_document_id"
        : "invalid_document_id",
  };
};
