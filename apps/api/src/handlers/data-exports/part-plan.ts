// Split an export into parts at matter boundaries.

import { panic } from "better-result";

type PlannedMatter = {
  matterId: string;
  /** Sum of the stored sizes of every document version in the matter. */
  estimatedBytes: number;
};

export type PlannedPart = {
  /** 1-based; part 1 also carries the organisation-level records. */
  index: number;
  matterIds: string[];
  estimatedBytes: number;
};

type PlanPartsArgs = {
  matters: readonly PlannedMatter[];
  targetBytes: number;
  /** Organisation-level records (contacts, clauses, templates) in part 1. */
  organizationBytes: number;
};

/**
 * Pack matters, in the given order, into consecutive parts of at most
 * `targetBytes` each. A matter is never split: every part holds complete
 * matters and is usable on its own. A matter larger than the target becomes
 * an oversized part (ZIP64 covers it) rather than being cut in two. There is
 * always at least one part, so an organisation with no matters still gets
 * its organisation-level records.
 */
export const planParts = ({
  matters,
  targetBytes,
  organizationBytes,
}: PlanPartsArgs): PlannedPart[] => {
  if (!(targetBytes > 0)) {
    return panic("Part target size must be positive");
  }
  const parts: PlannedPart[] = [];
  let current: PlannedPart = {
    index: 1,
    matterIds: [],
    estimatedBytes: organizationBytes,
  };
  for (const matter of matters) {
    const fits = current.estimatedBytes + matter.estimatedBytes <= targetBytes;
    if (!fits && current.matterIds.length > 0) {
      parts.push(current);
      current = {
        index: current.index + 1,
        matterIds: [],
        estimatedBytes: 0,
      };
    }
    current.matterIds.push(matter.matterId);
    current.estimatedBytes += matter.estimatedBytes;
  }
  parts.push(current);
  return parts;
};
