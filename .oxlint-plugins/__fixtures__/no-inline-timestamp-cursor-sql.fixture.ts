declare const cursor: string;

// A cursor projection without the canonical UTC marker must be rejected.
// oxlint-disable-next-line no-inline-timestamp-cursor-sql/no-inline-timestamp-cursor-sql
const _legacyFormat = 'YYYY-MM-DD"T"HH24:MI:SS.US';

// An inline cursor boundary must use the shared parser-aware helper.
// oxlint-disable-next-line no-inline-timestamp-cursor-sql/no-inline-timestamp-cursor-sql
const _inlineBoundary = `${cursor}::timestamp AT TIME ZONE 'UTC'`;

// The canonical projection includes its UTC marker.
const _canonicalFormat = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// Timezone-aware casts and unrelated date formats are not cursor re-anchors.
const _awareBoundary = `${cursor}::timestamptz`;
const _facetFormat = "YYYY";

export const __noInlineTimestampCursorSqlFixture = {
  _legacyFormat,
  _inlineBoundary,
  _canonicalFormat,
  _awareBoundary,
  _facetFormat,
};
