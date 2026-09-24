/**
 * How a public decision read's address reached the decision it returned.
 *
 * A publisher can serve part of a decision under an id of its own, such as
 * written reasons published apart from their ruling. Once the ruling holds
 * that part, the part's standalone row is absorbed into it, and a read of the
 * old id or slug returns the ruling with this resolution, so a client can
 * move to the ruling's address and to the part inside it.
 */
export const DECISION_READ_RESOLUTION = {
  /** The address names the returned decision itself. */
  DIRECT: "direct",
  /** The address names a supplement absorbed into the returned decision. */
  ABSORBED_SUPPLEMENT: "absorbed-supplement",
} as const;

export type DecisionReadResolution<TDecisionId extends string = string> =
  | { type: typeof DECISION_READ_RESOLUTION.DIRECT }
  | {
      type: typeof DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT;
      /** The absorbed row the address named. */
      absorbedDecisionId: TDecisionId;
      /**
       * The prefix the supplement's block anchors carry in the returned
       * decision's document: an anchor into the old row, prefixed, names the
       * same block.
       */
      anchorPrefix: string;
    };
