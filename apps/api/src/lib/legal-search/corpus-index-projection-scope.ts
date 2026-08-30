import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";

export const CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT = 256;

export type CorpusProjectionEntityId =
  | SafeId<"caseLawDecision">
  | SafeId<"legislationDocument">;

export const CORPUS_PROJECTION_GENERATION_SCOPE = {
  type: "generation",
} as const;

export type CorpusProjectionWorkScope =
  | typeof CORPUS_PROJECTION_GENERATION_SCOPE
  | {
      type: "subjects";
      entityIds: readonly CorpusProjectionEntityId[];
    };

/**
 * Return null for a generation walk or the exact bounded subject set. Callers
 * place the returned IDs in the same SQL statement that claims work, so an
 * allowlist check can never race a later broad claim.
 */
export const entityIdsForCorpusProjectionWorkScope = (
  scope: CorpusProjectionWorkScope,
): CorpusProjectionEntityId[] | null => {
  switch (scope.type) {
    case "generation":
      return null;
    case "subjects":
      if (
        scope.entityIds.length === 0 ||
        scope.entityIds.length >
          CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT ||
        new Set(scope.entityIds).size !== scope.entityIds.length
      ) {
        return panic(
          `Corpus projection subject scope must contain 1 to ${CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT} unique entities`,
        );
      }
      return [...scope.entityIds];
    default:
      return scope satisfies never;
  }
};
