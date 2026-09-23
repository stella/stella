import type { ConstantMap } from "@/api/lib/constant-map";

/** Lanes the citation-authority sweep keeps a position for. One today. */
export const CITATION_AUTHORITY_SWEEP_SCOPES = ["global"] as const;

type CitationAuthoritySweepScope =
  (typeof CITATION_AUTHORITY_SWEEP_SCOPES)[number];

export const CITATION_AUTHORITY_SWEEP_SCOPE = {
  GLOBAL: "global",
} as const satisfies ConstantMap<CitationAuthoritySweepScope>;
