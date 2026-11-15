/**
 * The facts a re-check read, stated against the facts its run pinned. A
 * re-check event stores only the difference, so it pins its evidence by
 * value without repeating the run's; applying the difference to the run's
 * facts gives back exactly the facts the grader read.
 */

import { stableStringify } from "@stll/stable-stringify";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  RecheckFactChanges,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";

/** The facts the re-check read, against the facts the run pinned. */
export const factChangesFrom = (
  pinned: readonly VerificationEvidenceFact[],
  current: readonly VerificationEvidenceFact[],
): RecheckFactChanges => {
  const pinnedById = new Map(
    pinned.map((fact) => [fact.factEntityId, stableStringify(fact)]),
  );
  const currentIds = new Set(current.map((fact) => fact.factEntityId));
  return {
    changed: current.filter(
      (fact) => pinnedById.get(fact.factEntityId) !== stableStringify(fact),
    ),
    removed: pinned
      .map((fact) => fact.factEntityId)
      .filter((factId) => !currentIds.has(factId)),
  };
};

/** The facts a re-check read: the run's pinned facts with its changes, the
 *  run's order first and facts new since then after them. */
export const applyFactChanges = (
  pinned: readonly VerificationEvidenceFact[],
  { changed, removed }: RecheckFactChanges,
): VerificationEvidenceFact[] => {
  const changedById = new Map(changed.map((fact) => [fact.factEntityId, fact]));
  const gone = new Set<SafeId<"entity">>(removed);
  const pinnedIds = new Set(pinned.map((fact) => fact.factEntityId));
  return [
    ...pinned
      .filter((fact) => !gone.has(fact.factEntityId))
      .map((fact) => changedById.get(fact.factEntityId) ?? fact),
    ...changed.filter((fact) => !pinnedIds.has(fact.factEntityId)),
  ];
};
