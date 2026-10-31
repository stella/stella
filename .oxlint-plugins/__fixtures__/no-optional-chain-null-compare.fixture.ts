// Passive regression fixture for `no-optional-chain-null-compare/no-optional-chain-null-compare`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const log: { closedAt: Date | null } | undefined;

// --- Flagged: an optional chain compared strictly with null ---
// oxlint-disable-next-line no-optional-chain-null-compare/no-optional-chain-null-compare
export const _a = log?.closedAt !== null;

// --- Allowed: the object narrowed first, or absence folded in ---
// expect-clean: no-optional-chain-null-compare/no-optional-chain-null-compare
export const _b = log !== undefined && log.closedAt !== null;
export const _c = (log?.closedAt ?? null) !== null;
