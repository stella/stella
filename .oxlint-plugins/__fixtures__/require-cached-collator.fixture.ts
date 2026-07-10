// Passive regression fixture for
// `require-cached-collator/require-cached-collator`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.
//
// Lines without a disable directive must continue to pass — they cover the
// allow-list (the collation helper's own comparator, reached through
// `compare()`, never `localeCompare`).

declare const locale: string;
declare const compareByLocale: (
  locale: string,
) => (a: string, b: string) => number;

type Named = { name: string };
declare const a: Named;
declare const b: Named;

// --- Flagged: bare localeCompare, with or without a locale argument ---
// oxlint-disable-next-line require-cached-collator/require-cached-collator
const _r1 = a.name.localeCompare(b.name);
// oxlint-disable-next-line require-cached-collator/require-cached-collator
const _r2 = a.name.localeCompare(b.name, locale);
// oxlint-disable-next-line require-cached-collator/require-cached-collator
const _r3 = [a, b].sort((x, y) => x.name.localeCompare(y.name));

// --- Allowed: routed through the shared collation helper (must NOT be flagged) ---
const _ok1 = compareByLocale(locale)(a.name, b.name);
const _ok2 = [a, b].sort((x, y) => compareByLocale(locale)(x.name, y.name));

export const __requireCachedCollatorFixture = { _r1, _r2, _r3, _ok1, _ok2 };
