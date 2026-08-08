declare const or: (...values: unknown[]) => unknown;
declare const eq: (...values: unknown[]) => unknown;
declare const lt: (...values: unknown[]) => unknown;
declare const pgTimestampCursorBoundary: (value: unknown) => unknown;
declare const timestamp: unknown;
declare const column: unknown;

// A repeated boundary inside a keyset disjunction must use codec.keysetAfter.
// oxlint-disable-next-line require-timestamp-id-cursor-codec/require-timestamp-id-cursor-codec
const _manualKeyset = or(
  lt(column, pgTimestampCursorBoundary(timestamp)),
  eq(column, pgTimestampCursorBoundary(timestamp)),
);

// A one-sided range boundary is not a two-column keyset predicate.
const _singleBoundary = lt(column, pgTimestampCursorBoundary(timestamp));

// Heterogeneous tuple comparisons use one parsed boundary and remain valid.
const _heterogeneousTuple = [
  pgTimestampCursorBoundary(timestamp),
  "id",
  "type",
];

export const __requireTimestampIdCursorCodecFixture = {
  _manualKeyset,
  _singleBoundary,
  _heterogeneousTuple,
};
