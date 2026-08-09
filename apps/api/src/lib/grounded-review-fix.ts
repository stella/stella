export type GroundedReviewFix = {
  kind: "replaceBlock" | "insertAfterBlock";
  blockId: string;
  text: string;
};

type BuildGroundedReviewFixArgs = {
  kind: GroundedReviewFix["kind"];
  proposedText: string | null | undefined;
  supportingEvidenceVerified: boolean;
  targetAnchors: readonly { blockId: string }[];
};

/**
 * Builds an executable document edit only from verified evidence and a
 * verified target anchor. Callers decide which cited target block is a safe
 * semantic anchor; this boundary never invents one from document position.
 */
export const buildGroundedReviewFix = ({
  kind,
  proposedText,
  supportingEvidenceVerified,
  targetAnchors,
}: BuildGroundedReviewFixArgs): GroundedReviewFix | null => {
  const text = proposedText?.trim();
  const blockId = targetAnchors.at(0)?.blockId;
  if (!text || !supportingEvidenceVerified || !blockId) {
    return null;
  }
  return { kind, blockId, text };
};
