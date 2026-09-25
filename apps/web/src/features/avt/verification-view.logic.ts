import { panic } from "better-result";

import type { ClaimAnchor, VerificationClaim } from "@/features/avt/types";

/**
 * Pure presentation logic for a claim span in the document view. Takes only
 * the two facts that determine the answer (whether THIS claim matches the
 * active filter, and whether a filter is active at all) so a caller cannot
 * compute "matches" once per passage and apply it to every claim in it.
 */
export const spanPresentation = ({
  matches,
  filterActive,
}: {
  matches: boolean;
  filterActive: boolean;
}): { dim: boolean; highlight: boolean } => ({
  dim: filterActive && !matches,
  highlight: filterActive && matches,
});

/**
 * A run of claims that sit in the same DOCX block or on the same PDF page,
 * in reading order. The run stores each claim's own words and where they sit,
 * not the text around them, so the document pane renders these passages
 * rather than the full document.
 */
export type ClaimPassage = {
  key: string;
  /** The block or page every claim of the passage is anchored in. */
  anchorKey: string;
  /** The PDF page the passage is on; null for a DOCX block. */
  pageNumber: number | null;
  claims: VerificationClaim[];
};

const anchorKey = (anchor: ClaimAnchor): string => {
  switch (anchor.type) {
    case "docx-block": {
      return `block:${anchor.blockId}`;
    }
    case "pdf-page": {
      return `page:${String(anchor.pageNumber)}`;
    }
    default: {
      anchor satisfies never;
      return panic(`Unhandled claim anchor: ${String(anchor)}`);
    }
  }
};

/**
 * Group claims into passages. Claims arrive in reading order (`position`);
 * consecutive claims anchored in the same block or page share a passage, and
 * within it they are ordered by where they start.
 */
export const groupClaimsIntoPassages = (
  claims: readonly VerificationClaim[],
): ClaimPassage[] => {
  const passages: ClaimPassage[] = [];
  const ordered = claims.toSorted((a, b) => a.position - b.position);
  for (const claim of ordered) {
    const key = anchorKey(claim.anchor);
    const last = passages.at(-1);
    if (last?.anchorKey === key) {
      last.claims.push(claim);
      continue;
    }
    passages.push({
      key: `${key}#${String(passages.length)}`,
      anchorKey: key,
      pageNumber:
        claim.anchor.type === "pdf-page" ? claim.anchor.pageNumber : null,
      claims: [claim],
    });
  }
  for (const passage of passages) {
    passage.claims.sort((a, b) => a.anchor.start - b.anchor.start);
  }
  return passages;
};

/** Claim ids in the order the document pane shows them. */
export const passageReadingOrder = (
  passages: readonly ClaimPassage[],
): VerificationClaim["id"][] =>
  passages.flatMap((passage) => passage.claims.map((claim) => claim.id));
