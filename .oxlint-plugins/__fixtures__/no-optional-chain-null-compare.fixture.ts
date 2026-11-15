// Passive regression fixture for the `no-optional-chain-null-compare` plugin
// (`no-optional-chain-null-compare`, `no-optional-chain-absent-match`) and its
// split with `typescript/prefer-optional-chain`.
//
// `oxlint-disable-next-line` directives suppress cases a rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive must keep passing.
//
// Every strict nullish comparison form appears twice, as an optional chain
// and narrowed (loose equality is banned repository-wide; the rule test
// covers it). Exactly one of the two spellings is flagged, by exactly one rule:
// the chain when an absent object compares true (ours), the narrowed spelling
// when the chain means the same (prefer-optional-chain). A form owned by both
// rules or by neither fails this file.

declare const log: { closedAt: Date | null | undefined } | undefined;

// --- `=== null`: false when absent, prefer-optional-chain owns it ---
export const _strictNullChain = log?.closedAt === null;
// oxlint-disable-next-line typescript/prefer-optional-chain
export const _strictNullNarrowed = log !== undefined && log.closedAt === null;

// --- `!== null`: true when absent, no-optional-chain-null-compare ---
// oxlint-disable-next-line no-optional-chain-null-compare/no-optional-chain-null-compare
export const _strictNotNullChain = log?.closedAt !== null;
export const _strictNotNullNarrowed =
  log !== undefined && log.closedAt !== null;

// --- `=== undefined`: true when absent, no-optional-chain-absent-match ---
// oxlint-disable-next-line no-optional-chain-null-compare/no-optional-chain-absent-match
export const _strictUndefinedChain = undefined === log?.closedAt;
export const _strictUndefinedNarrowed =
  log !== undefined && log.closedAt === undefined;

// --- `!== undefined`: false when absent, prefer-optional-chain owns it ---
export const _strictNotUndefinedChain = log?.closedAt !== undefined;
// oxlint-disable-next-line typescript/prefer-optional-chain
export const _strictNotUndefinedNarrowed = log !== undefined && log.closedAt !== undefined;

// --- "Absent or unset" narrowed with `||`: prefer-optional-chain folds it ---
// With a value that cannot be null, prefer-optional-chain asks for
// `unset?.closedAt === undefined`, which no-optional-chain-absent-match then
// reports: a loop. So this spelling is avoided; flip to
// `unset?.closedAt !== undefined` with the branches swapped, or return early.
declare const unset: { closedAt: Date | undefined } | undefined;
// oxlint-disable-next-line typescript/prefer-optional-chain
export const _orNarrowedUndefined = unset === undefined || unset.closedAt === undefined;
export const _flippedUndefinedChain = unset?.closedAt !== undefined;

// --- Folded absence stays clean for both rules ---
// expect-clean: no-optional-chain-null-compare/no-optional-chain-null-compare, no-optional-chain-null-compare/no-optional-chain-absent-match
export const _folded = (log?.closedAt ?? null) !== null;
