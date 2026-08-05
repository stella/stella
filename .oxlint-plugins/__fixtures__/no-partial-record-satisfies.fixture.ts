// Passive regression fixture for
// `no-partial-record-satisfies/no-partial-record-satisfies`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the `Partial`
// unwrap or the `Readonly` peeling), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

type Union = "a" | "b" | "c";

// `as const satisfies Partial<Record<...>>` — the idiom that caused the
// consent-classification bug.
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies
const asConstPartial = {
  a: 1,
} as const satisfies Partial<Record<Union, number>>;

// Non-`as const` `satisfies Partial<Record<...>>` on an object literal.
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies
const bareSatisfiesPartial = { a: 1 } satisfies Partial<Record<Union, number>>;

// `Readonly<Partial<Record<...>>>` — outer `Readonly` wrapper.
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies
const readonlyOuter = {
  a: 1,
} as const satisfies Readonly<Partial<Record<Union, number>>>;

// `Partial<Readonly<Record<...>>>` — inner `Readonly` wrapper.
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies
const readonlyInner = {
  a: 1,
} as const satisfies Partial<Readonly<Record<Union, number>>>;

// --- Cases the rule MUST NOT flag ---

// Total `Record`, no `Partial` — the required fix.
const totalRecord = {
  a: 1,
  b: 2,
  c: 3,
} as const satisfies Record<Union, number>;

// Type-annotation position, not `satisfies` — a function parameter.
const acceptsOverrides = (overrides: Partial<Record<Union, number>>) =>
  overrides;

// Type-annotation position — a variable/accumulator annotation.
const accumulator: Partial<Record<Union, number>> = { a: 1 };

// Type-annotation position — a type alias for genuinely sparse data.
type SparseByUnion = Partial<Record<Union, number>>;

// `satisfies Partial<Record<...>>` on a non-object-literal expression.
const fromHelper = (): Partial<Record<Union, number>> => ({ a: 1 });
const notAnObjectLiteral = fromHelper() satisfies Partial<
  Record<Union, number>
>;

export const __noPartialRecordSatisfiesFixture = {
  asConstPartial,
  bareSatisfiesPartial,
  readonlyOuter,
  readonlyInner,
  totalRecord,
  acceptsOverrides,
  accumulator,
  notAnObjectLiteral,
};

export type { SparseByUnion };
