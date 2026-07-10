// Disallow the three classic date/timezone footguns in app source.
//
// 1. `new Date("YYYY-MM-DD")` (string or template argument without a "T")
//    parses as UTC midnight per the ECMAScript spec; rendered in any
//    timezone west of UTC it shows the PREVIOUS calendar day. In a legal
//    workspace, a deadline or hearing date shifted by a day is a
//    top-severity bug. A date-only string must go through
//    `parseIsoDateLocal` from `apps/{web,api}/src/lib/dates.ts`.
//
// 2. `Date.parse(...)` of a non-ISO string is engine-dependent
//    (unspecified by the spec), and for ISO strings it is exactly
//    `new Date(...).getTime()` — so the call carries risk with no upside.
//
// 3. Day-length millisecond arithmetic (`24 * 60 * 60 * 1000`,
//    `86_400_000`) used as calendar math breaks across a DST transition:
//    the clocks-change day is 23 or 25 hours, not 24. Calendar math must
//    use `addDays` from `lib/dates.ts`; a genuine 24-hour DURATION (TTL,
//    staleness window, polling interval) must use the named `DAY_IN_MS`
//    from `apps/{web,api}/src/lib/time.ts` (that module is allowlisted in
//    oxlint.config.ts as the one place the literal may appear).
//
// Flagged:
//   new Date("2024-01-01")
//   new Date(`${year}-${month}-${day}`)
//   Date.parse(anything)
//   const TTL = 24 * 60 * 60 * 1000;
//   const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
//   const day = 86_400_000;
//
// Allowed:
//   new Date("2024-01-01T00:00:00.000Z")      (full timestamp, spec-defined)
//   new Date(`${value}T00:00:00`)             (local wall-clock, spec-defined)
//   new Date(year, month - 1, day)            (date-parts constructor)
//   new Date(isoStringVariable)               (variable argument — documented
//                                              limitation: only literal and
//                                              template arguments are checked)
//   addDays(date, 7)  /  Date.now() - DAY_IN_MS
//
// Tests are excluded in oxlint.config.ts: they construct fixture instants
// from literals deterministically and deliberately demonstrate the footguns.

// A day-length multiplication chain: at least one 24, two 60s, and one
// 1000 among the numeric literal factors (any order, any extra factors).
const DAY_FACTOR_REQUIREMENTS: ReadonlyMap<number, number> = new Map([
  [24, 1],
  [60, 2],
  [1000, 1],
]);

const DAY_IN_MS_VALUE = 86_400_000;

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: string }) => void;
};

// Collect the numeric-literal leaves of a `*` chain (`a * b * c * ...`).
const collectProductLiterals = (node, out: number[]): void => {
  if (!node) {
    return;
  }
  if (node.type === "BinaryExpression" && node.operator === "*") {
    collectProductLiterals(node.left, out);
    collectProductLiterals(node.right, out);
    return;
  }
  if (node.type === "Literal" && typeof node.value === "number") {
    out.push(node.value);
  }
};

const isDayLengthProduct = (literals: readonly number[]): boolean => {
  for (const [factor, needed] of DAY_FACTOR_REQUIREMENTS) {
    if (literals.filter((value) => value === factor).length < needed) {
      return false;
    }
  }
  return true;
};

// A string literal / template argument to `new Date(...)` is a bare
// calendar date (the UTC-midnight footgun) when it carries no "T" time
// separator. Template interpolations are opaque; only the static quasi
// text is inspected, so `` `${value}T00:00:00` `` passes and a date-only
// `` `${y}-${m}-${d}` `` is flagged.
const isDateOnlyStringArg = (arg): boolean => {
  if (!arg) {
    return false;
  }
  if (arg.type === "Literal") {
    return typeof arg.value === "string" && !arg.value.includes("T");
  }
  if (arg.type === "TemplateLiteral") {
    return !arg.quasis.some(
      (quasi) =>
        typeof quasi.value?.raw === "string" && quasi.value.raw.includes("T"),
    );
  }
  return false;
};

export default {
  meta: { name: "no-raw-date-parsing" },
  rules: {
    "no-raw-date-parsing": {
      meta: {
        type: "problem",
        messages: {
          dateOnlyString:
            "new Date() on a date-only string parses as UTC midnight and " +
            "renders as the previous day west of UTC. Use " +
            "parseIsoDateLocal() from lib/dates.ts.",
          dateParse:
            "Date.parse() is engine-dependent for non-ISO strings. Use " +
            "parseIsoDateLocal() from lib/dates.ts for calendar dates, or " +
            "new Date(fullIsoTimestamp).getTime() for timestamps.",
          dayMsArithmetic:
            "Raw day-length ms arithmetic breaks across DST (a calendar " +
            "day is 23-25 hours). Use addDays() from lib/dates.ts for " +
            "calendar math, or DAY_IN_MS from lib/time.ts for a plain " +
            "24-hour duration.",
        },
      },
      create(context: RuleContext) {
        return {
          NewExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "Identifier" &&
              callee.name === "Date" &&
              isDateOnlyStringArg(node.arguments?.[0])
            ) {
              context.report({ node, messageId: "dateOnlyString" });
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression" &&
              callee.object.type === "Identifier" &&
              callee.object.name === "Date" &&
              callee.property.type === "Identifier" &&
              callee.property.name === "parse"
            ) {
              context.report({ node, messageId: "dateParse" });
            }
          },
          Literal(node) {
            if (node.value === DAY_IN_MS_VALUE) {
              context.report({ node, messageId: "dayMsArithmetic" });
            }
          },
          BinaryExpression(node) {
            if (node.operator !== "*") {
              return;
            }
            // Only report the maximal chain, not every nested `*` inside it.
            const parent = node.parent;
            if (
              parent &&
              parent.type === "BinaryExpression" &&
              parent.operator === "*"
            ) {
              return;
            }
            const literals: number[] = [];
            collectProductLiterals(node, literals);
            if (isDayLengthProduct(literals)) {
              context.report({ node, messageId: "dayMsArithmetic" });
            }
          },
        };
      },
    },
  },
};
