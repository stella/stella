import { Result, TaggedError } from "better-result";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";

import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";
import { sortDeep } from "@/api/lib/sort-deep";
import { isRecord } from "@/api/lib/type-guards";

/**
 * What makes a parser's opinion boundaries unusable. Each is a parser defect,
 * so extraction rejects the record rather than resolving short forms across
 * boundaries it cannot trust.
 */
const CITATION_SCOPE_DEFECTS = {
  DUPLICATE_OPINION: "duplicate-opinion",
  EMPTY_OPINION: "empty-opinion",
  DUPLICATE_BLOCK: "duplicate-block",
  UNKNOWN_BLOCK: "unknown-block",
  DISCONTIGUOUS_OPINION: "discontiguous-opinion",
  INVALID_BOUNDARIES: "invalid-boundaries",
  INVALID_ENVELOPE: "invalid-envelope",
  AST_HASH_MISMATCH: "ast-hash-mismatch",
} as const;

type CitationScopeDefect =
  (typeof CITATION_SCOPE_DEFECTS)[keyof typeof CITATION_SCOPE_DEFECTS];

const CITATION_SCOPE_BOUNDARIES: ReadonlySet<string> = new Set([
  "proven",
  "unproven",
]);

export class CitationScopesRejectedError extends TaggedError(
  "CitationScopesRejectedError",
)<{
  message: string;
  defect: CitationScopeDefect;
  opinionId: string;
}> {}

/** The opinion and boundary confidence for each block; absent means none. */
export type CitationScopeIndex = ReadonlyMap<
  string,
  { readonly opinionId: string; readonly boundaries: "proven" | "unproven" }
>;

export const CITATION_SCOPE_METADATA_KEY = "_stellaCitationScopes";
const CITATION_SCOPE_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export type CitationScopeEnvelope = {
  version: typeof CITATION_SCOPE_VERSION;
  astHash: string;
  opinions: readonly CitationOpinionScope[];
};

/** Hash the JSON shape that both jsonb and the corpus payload actually keep. */
export const citationScopeAstHash = (ast: DocumentAst): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortDeep(ast)))
    .digest("hex");

export const citationScopeEnvelope = (
  ast: DocumentAst,
  opinions: readonly CitationOpinionScope[],
): CitationScopeEnvelope => ({
  version: CITATION_SCOPE_VERSION,
  astHash: citationScopeAstHash(ast),
  opinions,
});

/** Metadata is persisted JSON and must be checked again before reuse. */
export const validatedCitationScopes = (
  metadata: Record<string, unknown>,
  ast: unknown,
): Result<
  readonly CitationOpinionScope[] | undefined,
  CitationScopesRejectedError
> => {
  const value = metadata[CITATION_SCOPE_METADATA_KEY];
  if (value === undefined) {
    return Result.ok(undefined);
  }
  if (!isDocumentAst(ast)) {
    return rejected(CITATION_SCOPE_DEFECTS.INVALID_ENVELOPE, "");
  }
  if (
    !isRecord(value) ||
    value["version"] !== CITATION_SCOPE_VERSION ||
    typeof value["astHash"] !== "string" ||
    !SHA256_HEX.test(value["astHash"]) ||
    !Array.isArray(value["opinions"]) ||
    !value["opinions"].every(
      (opinion: unknown) =>
        isRecord(opinion) &&
        typeof opinion["opinionId"] === "string" &&
        typeof opinion["boundaries"] === "string" &&
        Array.isArray(opinion["blockIds"]) &&
        opinion["blockIds"].every((id: unknown) => typeof id === "string"),
    )
  ) {
    return rejected(CITATION_SCOPE_DEFECTS.INVALID_ENVELOPE, "");
  }
  if (value["astHash"] !== citationScopeAstHash(ast)) {
    return rejected(CITATION_SCOPE_DEFECTS.AST_HASH_MISMATCH, "");
  }
  const opinions = value["opinions"].filter(
    (opinion: unknown): opinion is CitationOpinionScope =>
      isRecord(opinion) &&
      typeof opinion["opinionId"] === "string" &&
      (opinion["boundaries"] === "proven" ||
        opinion["boundaries"] === "unproven") &&
      Array.isArray(opinion["blockIds"]) &&
      opinion["blockIds"].every((id: unknown) => typeof id === "string"),
  );
  if (opinions.length !== value["opinions"].length) {
    return rejected(CITATION_SCOPE_DEFECTS.INVALID_ENVELOPE, "");
  }
  const indexed = indexCitationScopes(ast.blocks, opinions);
  return Result.isError(indexed)
    ? Result.err(indexed.error)
    : Result.ok(opinions);
};

/** Preserve an existing document's scope statement during metadata refresh. */
export const preserveCitationScopeEnvelope = (
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> => {
  const envelope = stored?.[CITATION_SCOPE_METADATA_KEY];
  return envelope === undefined
    ? incoming
    : { ...incoming, [CITATION_SCOPE_METADATA_KEY]: envelope };
};

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
  const opinionOf = new Map<
    string,
    { readonly opinionId: string; readonly boundaries: "proven" | "unproven" }
  >();
  const opinions = new Set<string>();
  for (const { blockIds, boundaries, opinionId } of scopes) {
    if (!CITATION_SCOPE_BOUNDARIES.has(boundaries)) {
      return rejected(CITATION_SCOPE_DEFECTS.INVALID_BOUNDARIES, opinionId);
    }
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
      opinionOf.set(blockId, { opinionId, boundaries });
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
