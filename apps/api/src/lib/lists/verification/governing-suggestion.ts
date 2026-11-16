// The record a reviewer is offered first when a claim is withheld between
// two facts. Only a suggestion: a record conflict stays open until a person
// names the governing fact, and the event that does so keeps what was
// suggested beside what was chosen.

import type { SafeId } from "@/api/lib/branded-types";
import type { FactTier } from "@/api/lib/lists/source-kind";
import type { RecordConflict } from "@/api/lib/lists/verification/contract";

type SuggestedGoverningFactArgs = {
  conflict: Pick<RecordConflict, "factEntityIds">;
  tierOf: (factEntityId: SafeId<"entity">) => FactTier;
};

/**
 * A document's record of what happened is suggested over a person's account
 * of it. Any other pairing (two records, two accounts, or a side without a
 * source) suggests neither: nothing in the sources says which should win.
 */
export const suggestedGoverningFactId = ({
  conflict: { factEntityIds },
  tierOf,
}: SuggestedGoverningFactArgs): SafeId<"entity"> | null => {
  const [first, second] = factEntityIds;
  const firstTier = tierOf(first);
  const secondTier = tierOf(second);
  if (firstTier === "document" && secondTier === "testimony") {
    return first;
  }
  if (firstTier === "testimony" && secondTier === "document") {
    return second;
  }
  return null;
};
