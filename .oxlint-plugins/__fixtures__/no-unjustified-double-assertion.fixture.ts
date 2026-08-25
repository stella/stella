// Passive regression fixture for
// `no-unjustified-double-assertion/no-unjustified-double-assertion`.

type MatterSummary = {
  matterId: string;
  title: string;
};

declare const externalValue: unknown;
declare const openRecord: Record<string, unknown>;

// oxlint-disable-next-line no-unjustified-double-assertion/no-unjustified-double-assertion -- fixture: unknown laundering has no reviewed runtime invariant
export const unreviewedUnknown = externalValue as unknown as MatterSummary;

// oxlint-disable-next-line no-unjustified-double-assertion/no-unjustified-double-assertion -- fixture: an open record is asserted into a closed domain contract
export const unreviewedRecord = openRecord as Record<
  string,
  unknown
> as MatterSummary;

// SAFETY: the adapter validates matterId and title before returning the value.
export const reviewedBoundary = externalValue as unknown as MatterSummary;

// See SAFETY comment on reviewedBoundary above.
export const referencedBoundary = externalValue as unknown as MatterSummary;

// SAFETY: this rationale belongs only to the direct assertion below.
export const unrelatedDirectAssertion = externalValue as MatterSummary;

// oxlint-disable-next-line no-unjustified-double-assertion/no-unjustified-double-assertion -- fixture: an intervening statement separates this cast from the unrelated rationale
export const separatedBoundary = externalValue as unknown as MatterSummary;

export const earlierStatement = externalValue as MatterSummary; // SAFETY: this comment documents only the earlier statement.

export const trailingCommentBoundary =
  // oxlint-disable-next-line no-unjustified-double-assertion/no-unjustified-double-assertion -- fixture: a trailing comment on an earlier statement cannot justify this cast
  externalValue as unknown as MatterSummary;

export const directAssertion = externalValue as MatterSummary;

declare const identified: { matterId: string };
export const nonBroadIntermediate = identified as {
  matterId: string;
} as MatterSummary;
