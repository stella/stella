import { Result, TaggedError } from "better-result";

import type { Block } from "@/api/lib/case-law/document-ast";
import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";

/**
 * What makes a parser's opinion boundaries unusable. Each is a parser defect,
 * so extraction rejects the record rather than resolving short forms across
 * boundaries it cannot trust.
 */
export const CITATION_SCOPE_DEFECTS = {
  DUPLICATE_OPINION: "duplicate-opinion",
  EMPTY_OPINION: "empty-opinion",
  DUPLICATE_BLOCK: "duplicate-block",
  UNKNOWN_BLOCK: "unknown-block",
  DISCONTIGUOUS_OPINION: "discontiguous-opinion",
} as const;

type CitationScopeDefect =
  (typeof CITATION_SCOPE_DEFECTS)[keyof typeof CITATION_SCOPE_DEFECTS];

export class CitationScopesRejectedError extends TaggedError(
  "CitationScopesRejectedError",
)<{
  message: string;
  defect: CitationScopeDefect;
  opinionId: string;
}> {}

/** The opinion each block belongs to; a block absent here is in none. */
export type CitationScopeIndex = ReadonlyMap<string, string>;

const rejected = (
  defect: CitationScopeDefect,
  opinionId: string,
): Result<never, CitationScopesRejectedError> =>
  Result.err(
    new CitationScopesRejectedError({
      message: `Citation scope ${opinionId} is unusable: ${defect}`,
      defect,
      opinionId,
    }),
  );

/**
 * Checks the stated opinions against the document and indexes them: IDs are
 * unique, every block ID names a block of this document and at most one
 * opinion, and each opinion is one unbroken run of blocks.
 */
export const indexCitationScopes = (
  blocks: readonly Block[],
  scopes: readonly CitationOpinionScope[],
): Result<CitationScopeIndex, CitationScopesRejectedError> => {
  const position = new Map(blocks.map((block, index) => [block.id, index]));
  const opinionOf = new Map<string, string>();
  const opinions = new Set<string>();
  for (const { blockIds, opinionId } of scopes) {
    if (opinions.has(opinionId)) {
      return rejected(CITATION_SCOPE_DEFECTS.DUPLICATE_OPINION, opinionId);
    }
    opinions.add(opinionId);
    if (blockIds.length === 0) {
      return rejected(CITATION_SCOPE_DEFECTS.EMPTY_OPINION, opinionId);
    }
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const blockId of blockIds) {
      const at = position.get(blockId);
      if (at === undefined) {
        return rejected(CITATION_SCOPE_DEFECTS.UNKNOWN_BLOCK, opinionId);
      }
      if (opinionOf.has(blockId)) {
        return rejected(CITATION_SCOPE_DEFECTS.DUPLICATE_BLOCK, opinionId);
      }
      opinionOf.set(blockId, opinionId);
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
    // Unique blocks spanning exactly their own count leave no gap for another
    // opinion's block or an unassigned one.
    if (last - first + 1 !== blockIds.length) {
      return rejected(CITATION_SCOPE_DEFECTS.DISCONTIGUOUS_OPINION, opinionId);
    }
  }
  return Result.ok(opinionOf);
};
