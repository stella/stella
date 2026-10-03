import type { ClaimAnchor } from "@/api/lib/lists/verification/contract";

export const CLAIM_CONTEXT_MAX = 1500;

/** UTF-16 offsets refer to the same block text used to ground the claim. */
export const claimPassage = (
  text: string,
  { start, end }: Pick<ClaimAnchor, "start" | "end">,
): string => {
  if (text.length <= CLAIM_CONTEXT_MAX) {
    return text;
  }
  const from = Math.max(
    0,
    Math.min(
      text.length - CLAIM_CONTEXT_MAX,
      Math.floor((start + end - CLAIM_CONTEXT_MAX) / 2),
    ),
  );
  return text.slice(from, from + CLAIM_CONTEXT_MAX);
};
