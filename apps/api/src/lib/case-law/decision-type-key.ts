// parser-output-unchanged: decisionTypeKey is unchanged; only cz-nss reads the docket check, and it bumps its own version.
/** A comparison key only; the publisher's spelling remains on the decision. */
export const decisionTypeKey = (stated: string | null | undefined) =>
  stated?.normalize("NFC").trim().toLowerCase() || undefined;

/** A number over a year: the core of every docket (`63 Az 17/2026 - 28`). */
const DOCKET_SHAPE = /\d ?\/ ?\d{4}/u;

/**
 * Whether a value read as a decision type is a docket number instead. No
 * decision type's name holds a number over a year, so such a value is a
 * column read out of place, never a type: an adapter drops it, and a stored
 * one is counted as `other`.
 */
export const isDocketShapedDecisionType = (stated: string): boolean =>
  DOCKET_SHAPE.test(stated);
