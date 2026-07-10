// Passive regression fixture for `no-raw-date-parsing/no-raw-date-parsing`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.
//
// Lines without a disable directive must continue to pass — they cover the
// allowed shapes (full ISO timestamps, date-parts constructor, variable
// arguments, non-day-length arithmetic).

declare const year: string;
declare const month: string;
declare const day: string;
declare const isoTimestamp: string;
declare const rawInput: string;
declare const lookbackDays: number;

// --- Flagged: date-only string/template arguments (UTC-midnight shift) ---
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dateOnlyLiteral = new Date("2024-01-01");
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dateOnlyTemplate = new Date(`${year}-${month}-${day}`);
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dateOnlyGrouped = new Date(("2024-01-01"));
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dateOnlyTyped = new Date("2024-01-01" satisfies string);

// --- Flagged: Date.parse (engine-dependent for non-ISO input) ---
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _parsed = Date.parse(rawInput);

// --- Flagged: raw day-length ms arithmetic (DST-unsafe as calendar math) ---
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayChain = 24 * 60 * 60 * 1000;
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayChainWithFactor = lookbackDays * 24 * 60 * 60 * 1000;
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayChainReordered = 1000 * 60 * 60 * 24;
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayChainGrouped = 24 * 60 * (60 * 1000);
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayChainWithTypedGroup = 24 * ((60 * 60) satisfies number) * 1000;
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing
const _dayLiteralUnderscore = 86_400_000;
// oxlint-disable-next-line no-raw-date-parsing/no-raw-date-parsing, unicorn/numeric-separators-style
const _dayLiteralPlain = 86400000;

// --- Allowed: spec-defined timestamps, parts constructor, variables ---
const _fullUtc = new Date("2024-01-01T00:00:00.000Z");
const _localWallClock = new Date(`${year}-${month}-${day}T00:00:00`);
const _parts = new Date(2024, 0, 1);
const _fromVariable = new Date(isoTimestamp); // documented limitation
const _hourMs = 60 * 60 * 1000; // hour-length, not day-length
const _unrelatedProduct = 24 * 7;

export const noRawDateParsingFixture = [
  _dateOnlyLiteral,
  _dateOnlyTemplate,
  _dateOnlyGrouped,
  _dateOnlyTyped,
  _parsed,
  _dayChain,
  _dayChainWithFactor,
  _dayChainReordered,
  _dayChainGrouped,
  _dayChainWithTypedGroup,
  _dayLiteralUnderscore,
  _dayLiteralPlain,
  _fullUtc,
  _localWallClock,
  _parts,
  _fromVariable,
  _hourMs,
  _unrelatedProduct,
];
