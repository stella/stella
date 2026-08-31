/**
 * The reviewer flag vocabulary, shared by every surface that reviews something.
 *
 * A flag is what a reviewer says *about* an item, next to whatever disposition
 * the item's own workflow tracks: a files-table cell carries flags beside its
 * value, a document-review finding carries them beside its accept/dismiss
 * decision. The two surfaces are the same reviewer doing the same triage, so
 * they read one list — the cell control, the finding control, the two column
 * CHECKs, and the wire schemas all derive from here, and a flag added below
 * appears in all of them or fails typecheck in each.
 */

export const REVIEW_FLAGS = [
  "needs-review",
  "important",
  "follow-up",
  "contradiction",
  "verified",
] as const;

export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

export const REVIEW_FLAG = {
  NEEDS_REVIEW: "needs-review",
  IMPORTANT: "important",
  FOLLOW_UP: "follow-up",
  CONTRADICTION: "contradiction",
  VERIFIED: "verified",
} as const satisfies Record<string, ReviewFlag>;

/** Every member of the list is named above. A flag added to `REVIEW_FLAGS`
 *  without a constant fails typecheck here rather than reaching a call site
 *  that has no name for it. */
type UnnamedReviewFlag = Exclude<
  ReviewFlag,
  (typeof REVIEW_FLAG)[keyof typeof REVIEW_FLAG]
>;
true satisfies UnnamedReviewFlag extends never ? true : never;

/**
 * How many flags one item may carry. The set is closed and flags are a set
 * rather than a list, so this is the vocabulary's own size: no item can hold
 * a flag twice, and none can hold more kinds than exist.
 */
export const REVIEW_FLAGS_MAX_ITEMS = REVIEW_FLAGS.length;

export const isReviewFlag = (value: string): value is ReviewFlag =>
  REVIEW_FLAGS.some((flag) => flag === value);
