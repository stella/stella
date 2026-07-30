// Passive regression fixture for
// `no-naive-timestamp-cast/no-naive-timestamp-cast`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the spacing or
// spelled-out-form handling), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

const cursor = "2026-07-30T00:00:00.000000";

// Naive cast in a template literal.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _template = `created_at > ${cursor}::timestamp`;

// Spacing between `::` and the type name.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _spaced = `created_at > ${cursor}:: timestamp`;

// Spelled-out naive form.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _spelled = `${cursor}::timestamp without time zone`;

// Plain string literal.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _string = "indexed_at = $1::timestamp";

// ANSI CAST form.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _ansi = `CAST(${cursor} AS timestamp)`;

// Whitespace written as an escape sequence: the cooked segment carries a real
// newline even though the raw text holds the two-character `\n`.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _escapedWhitespace = `${cursor}::\ntimestamp`;

// ANSI CAST with precision and spelled-out suffix.
// oxlint-disable-next-line no-naive-timestamp-cast/no-naive-timestamp-cast
const _ansiSpelled = `CAST(${cursor} AS timestamp(6) without time zone)`;

// --- Cases the rule MUST NOT flag ---

// tz-aware cast.
const _tz = `created_at > ${cursor}::timestamptz`;

// Explicit re-anchor idiom: deliberate conversion of a zoneless value to an
// instant with a stated zone.
const _anchored = `(decision_date::timestamp AT TIME ZONE 'UTC')`;

// Re-anchored casts with a precision or the spelled-out form: the optional
// type-suffix groups must not backtrack past the anchor check.
const _anchoredPrecision = `(x::timestamp(6) AT TIME ZONE 'UTC')`;
const _anchoredSpelled = `(x::timestamp without time zone AT TIME ZONE 'UTC')`;

// SQL whitespace is arbitrary: a spelled-out type split across lines is the
// same type, and its re-anchor must still be recognized.
const _anchoredMultiline = `(x::timestamp without
  time zone AT TIME ZONE 'UTC')`;

// Anchored ANSI CAST: the re-anchor follows CAST's closing parenthesis.
const _anchoredAnsi = `CAST(x AS timestamp) AT TIME ZONE 'UTC'`;

// Composed fragments may add grouping between the cast and its anchor.
const _anchoredGrouped = `((x::timestamp)) AT TIME ZONE 'UTC'`;

// The spelled-out AWARE type is equivalent to timestamptz in both cast
// syntaxes and must not be flagged.
const _awareSpelled = `x::timestamp with time zone`;
const _awareAnsi = `CAST(x AS timestamp with time zone)`;

// SQL tolerates whitespace around the precision modifier; the aware and
// anchored checks must still see past it.
const _awareSpacedPrecision = `x::timestamp (6) with time zone`;
const _anchoredSpacedPrecision = `x::timestamp( 6 ) AT TIME ZONE 'UTC'`;

export const __noNaiveTimestampCastFixture = {
  _template,
  _spaced,
  _spelled,
  _string,
  _escapedWhitespace,
  _tz,
  _anchored,
  _anchoredPrecision,
  _anchoredSpelled,
  _anchoredMultiline,
  _ansi,
  _ansiSpelled,
  _anchoredAnsi,
  _anchoredGrouped,
  _awareSpelled,
  _awareAnsi,
  _awareSpacedPrecision,
  _anchoredSpacedPrecision,
};
