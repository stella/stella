// Passive regression fixture for
// `no-truncated-timestamp-comparison/no-truncated-timestamp-comparison`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the row-tuple walk
// or the column-name recognition), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { and, eq, gt, gte, lt, lte, ne, or, sql } from "drizzle-orm";

// Stand-ins for the schema objects and the values that reach a comparison.
// Only the shapes matter: the rule reads `<object>.<columnName>` and the
// operand's syntax, never their types.
const createdAt = sql`created_at`;
const decisions = {
  createdAt,
  updatedAt: sql`updated_at`,
  id: sql`id`,
  sourceId: sql`source_id`,
};
const allocations = {
  periodStart: sql`period_start`,
  periodEnd: sql`period_end`,
};
const searchDocuments = { updatedAt: sql`updated_at` };
const projectionIntents = {
  appendPublishBarrierAt: sql`append_publish_barrier_at`,
  cleanupNotBefore: sql`cleanup_not_before`,
};
const cursor = { createdAt: new Date(), id: "row-id" };
const checkpoint = {
  cursorCreatedAt: new Date(),
  cursorId: "row-id",
  snapshotAt: new Date(),
  revision: 3,
};
const casToken = "2026-08-07 09:00:00.123456+00";
const boundaryId = "row-id";
const pgTimestampCursorBoundary = (value: string) => sql`${value}::timestamptz`;

// --- Family A: raw SQL templates the rule MUST flag ---

// The ascending keyset: the boundary row is re-admitted on every page because
// the bound Date lost the column's microseconds.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _tupleAscending = sql`(${decisions.createdAt}, ${decisions.id}) > (${checkpoint.cursorCreatedAt}, ${checkpoint.cursorId})`;

// ...and the descending one, which instead skips rows sharing that millisecond.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _tupleDescending = sql`(${decisions.createdAt}, ${decisions.id}) <= (${checkpoint.cursorCreatedAt}, ${checkpoint.cursorId})`;

// A wider tuple resolves its first slot the same way.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _tupleThreeColumns = sql`(${decisions.createdAt}, ${decisions.sourceId}, ${decisions.id}) > (${checkpoint.cursorCreatedAt}, ${decisions.sourceId}, ${checkpoint.cursorId})`;

// The compare-and-set guard: never matches a row whose timestamp came from
// `now()`, so the guarded write silently no-ops.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _casGuard = sql`${decisions.updatedAt} IS NOT DISTINCT FROM ${checkpoint.snapshotAt}`;

// ...and its negation, which is the same comparison.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _casGuardNegated = sql`${decisions.updatedAt} IS DISTINCT FROM ${checkpoint.snapshotAt}`;

// A plain inequality against an interpolated timestamp column.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _plainComparison = sql`${decisions.createdAt} <= ${checkpoint.snapshotAt}`;

// The column can be written in the SQL text rather than interpolated.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _textColumn = sql`WHERE created_at > ${cursor.createdAt}`;

// ...quoted, and in the camelCase spelling of the same convention.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _quotedTextColumn = sql`WHERE "createdAt" >= ${cursor.createdAt}`;

// A column that predates the `...At` convention is still a timestamp column.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _legacyColumnName = sql`WHERE locked_until < ${checkpoint.snapshotAt}`;

// Postgres treats a comment as whitespace, so it cannot hide the operator.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _commentBeforeOperand = sql`${decisions.updatedAt} > /* boundary */ ${checkpoint.snapshotAt}`;

// An equality in a WHERE clause is a comparison, not an assignment, even when
// the statement also carries a SET list.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _updateWhereGuard = sql`UPDATE t SET generation = ${checkpoint.revision} WHERE updated_at = ${checkpoint.snapshotAt}`;

// The operand's producer is unknowable from here: a helper parameter is
// exactly the shape that carried the hazard into three separate call sites.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _viaParameter = (at: Date) => sql`${decisions.createdAt} > ${at}`;

const boundaryTimestamp = cursor.createdAt;
// The timestamp column can be on the right of a raw SQL comparison too.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _columnOnRight = sql`${boundaryTimestamp} < ${decisions.createdAt}`;

// --- Family B: Drizzle comparison calls the rule MUST flag ---

// The paged-list keyset that re-serves page one forever.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _keysetAfter = gt(decisions.createdAt, cursor.createdAt);

// ...and the descending twin that drops rows out of the listing.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _keysetBefore = lt(decisions.createdAt, cursor.createdAt);

// The tie-breaker leg of the same keyset: an equality on the truncated value.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _keysetTie = eq(decisions.createdAt, cursor.createdAt);

// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _notEqual = ne(decisions.updatedAt, checkpoint.snapshotAt);

// A backfill tier bounded by a snapshot timestamp read back from the database.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _snapshotUpperBound = lte(decisions.createdAt, checkpoint.snapshotAt);

// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _snapshotLowerBound = gte(decisions.createdAt, checkpoint.snapshotAt);

// The column may be written second; the operand is still the other argument.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _reversedArguments = lt(checkpoint.snapshotAt, decisions.createdAt);

// A pre-convention column name carries the same hazard.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _legacyColumnCall = lte(allocations.periodStart, checkpoint.snapshotAt);

// `new Date(...)` with an argument is a parsed value, not a clock read: this
// is precisely how a cursor's millisecond timestamp is rebuilt.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _parsedDate = gt(decisions.createdAt, new Date(casToken));

// A `let` can be reassigned after the clock read, so it is not provably one.
let mutableNow = new Date();
if (cursor.id === boundaryId) {
  mutableNow = cursor.createdAt;
}
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _mutableBinding = lte(decisions.updatedAt, mutableNow);

// Column-to-column comparisons run entirely in Postgres and are sound, but
// `searchDocuments.updatedAt` and `cursor.createdAt` are the same shape, so the
// rule cannot tell them apart. The few real sites carry a disable comment.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _columnToColumn = gt(decisions.updatedAt, searchDocuments.updatedAt);

// Two timestamp members owned by the same schema object are database-native
// operands when interpolated into one SQL template.
const _sameOwnerColumnToColumn = sql`${decisions.updatedAt} >= ${decisions.createdAt}`;
const _sameOwnerColumnTuple = sql`(${decisions.updatedAt}, ${decisions.id}) >= (${decisions.createdAt}, ${decisions.sourceId})`;
const _sameOwnerColumnCall = gte(decisions.updatedAt, decisions.createdAt);
const _legacySameOwnerColumn = sql`${projectionIntents.cleanupNotBefore} >= ${projectionIntents.appendPublishBarrierAt}`;

// A nested SQL fragment can still bind a truncated JS Date; the tag alone
// does not make every interpolation a database-native expression.
// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
const _nestedBoundDate = gt(decisions.createdAt, sql`${cursor.createdAt}`);

// Merely containing a clock read does not make the whole operand fresh.
const _conditionalClock = gt(
  decisions.createdAt,
  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison
  cursor.id === boundaryId ? cursor.createdAt : new Date(),
);

// --- Cases the rule MUST NOT flag ---

// An explicit cast keeps the operand at the column's precision whatever
// produced it: this is what `timestampMatchesCasToken` emits.
const _castCasGuard = sql`${decisions.updatedAt} IS NOT DISTINCT FROM ${casToken}::timestamptz`;
const _castComparison = sql`${decisions.createdAt} > ${casToken}::timestamptz`;
const _castTuple = sql`(${decisions.createdAt}, ${decisions.id}) > (${casToken}::timestamptz, ${boundaryId})`;

// The deliberate re-anchor of a zoneless value, which no-naive-timestamp-cast
// also sanctions.
const _reAnchoredCast = sql`${decisions.createdAt} <= (${casToken}::timestamp AT TIME ZONE 'UTC')`;

// A helper named in `allowedOperandCalls` emits its own cast.
const _boundaryHelper = sql`(${decisions.createdAt}, ${decisions.id}) < (${pgTimestampCursorBoundary(casToken)}, ${boundaryId})`;
const _boundaryHelperCall = lt(
  decisions.createdAt,
  pgTimestampCursorBoundary(casToken),
);

// The boundary never leaves the database, so nothing can truncate it.
const _inDatabaseBoundary = sql`(${decisions.createdAt}, ${decisions.id}) < (select b.created_at, b.id from t b where b.id = ${boundaryId})`;

// A nested SQL fragment is evaluated by Postgres; no JS Date is involved.
const _sqlOperand = sql`${decisions.updatedAt} <= ${sql`now()`}`;
const _sqlOperandCall = lte(decisions.updatedAt, sql`now()`);

// A cutoff read straight from the clock never round-tripped through the
// database, and an inequality against a moving cutoff does not care about
// sub-millisecond drift.
const _clockNow = lte(decisions.updatedAt, new Date());
const _clockDerived = lt(decisions.updatedAt, new Date(Date.now() - 60_000));
const _clockArithmetic = lt(decisions.updatedAt, new Date(Date.now()));

// ...including through one `const` hop within the file.
const staleBefore = new Date(Date.now() - 60_000);
const _clockBinding = lt(decisions.updatedAt, staleBefore);
const nowInstant = new Date();
const _clockBindingPlain = lte(decisions.updatedAt, nowInstant);

// A SET list assigns the column; it never reads it back.
const _setAssignment = sql`UPDATE t SET indexed_at = ${checkpoint.snapshotAt} WHERE id = ${boundaryId}`;

// The id legs of the same tuple and CAS guard are not timestamps.
const _idCasGuard = sql`${decisions.id} IS NOT DISTINCT FROM ${checkpoint.cursorId}`;
const _idComparison = sql`${decisions.sourceId} = ${checkpoint.cursorId}`;
const _idCall = eq(decisions.sourceId, checkpoint.cursorId);
const _nonTimestampCall = eq(decisions.id, cursor.id);

// A subselect between the tuples is not the `) OP (` shape.
const _tupleAgainstSubselect = sql`(${decisions.createdAt}, ${decisions.id}) > (select max(created_at), max(id) from t)`;

export const __noTruncatedTimestampComparisonFixture = {
  _tupleAscending,
  _tupleDescending,
  _tupleThreeColumns,
  _casGuard,
  _casGuardNegated,
  _plainComparison,
  _textColumn,
  _quotedTextColumn,
  _legacyColumnName,
  _commentBeforeOperand,
  _updateWhereGuard,
  _viaParameter,
  _keysetAfter,
  _keysetBefore,
  _keysetTie,
  _notEqual,
  _snapshotUpperBound,
  _snapshotLowerBound,
  _reversedArguments,
  _legacyColumnCall,
  _parsedDate,
  _mutableBinding,
  _columnToColumn,
  _sameOwnerColumnToColumn,
  _sameOwnerColumnTuple,
  _sameOwnerColumnCall,
  _legacySameOwnerColumn,
  _columnOnRight,
  _nestedBoundDate,
  _conditionalClock,
  _castCasGuard,
  _castComparison,
  _castTuple,
  _reAnchoredCast,
  _boundaryHelper,
  _boundaryHelperCall,
  _inDatabaseBoundary,
  _sqlOperand,
  _sqlOperandCall,
  _clockNow,
  _clockDerived,
  _clockArithmetic,
  _clockBinding,
  _clockBindingPlain,
  _setAssignment,
  _idCasGuard,
  _idComparison,
  _idCall,
  _nonTimestampCall,
  _tupleAgainstSubselect,
  _unused: [and, or],
};
