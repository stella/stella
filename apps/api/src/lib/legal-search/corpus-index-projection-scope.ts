import { panic } from "better-result";

import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexProjectionSubject } from "@/api/lib/legal-search/corpus-index-projection-desired-state";

export const CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT = 256;

export const CORPUS_PROJECTION_GENERATION_SCOPE = {
  type: "generation",
} as const;

type CorpusProjectionEntityId<Family extends CorpusFamily> = Extract<
  CorpusIndexProjectionSubject,
  { family: Family }
>["entityId"];

export type CorpusProjectionWorkScope<Family extends CorpusFamily> =
  | typeof CORPUS_PROJECTION_GENERATION_SCOPE
  | {
      type: "subjects";
      entityIds: readonly CorpusProjectionEntityId<Family>[];
    };

export type CorpusProjectionScopedWorkSelection<Family extends CorpusFamily> = {
  family: Family;
  scope: CorpusProjectionWorkScope<NoInfer<Family>>;
};

export type CorpusProjectionScopedWorkOptions<Family extends CorpusFamily> = {
  family: Family;
  scope?: CorpusProjectionWorkScope<NoInfer<Family>>;
};

/**
 * Return null for a generation walk or the exact bounded subject set. Callers
 * place the returned IDs in the same SQL statement that claims work, so an
 * allowlist check can never race a later broad claim.
 */
export const entityIdsForCorpusProjectionWorkScope = <
  Family extends CorpusFamily,
>(
  scope: CorpusProjectionWorkScope<Family>,
): CorpusProjectionEntityId<Family>[] | null => {
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
