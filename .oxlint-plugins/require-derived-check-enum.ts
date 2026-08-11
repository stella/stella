// Require a check constraint's enum list to be derived from its canonical
// const rather than hand-written as quoted literals.
//
// Drizzle enum columns already derive their accepted values
// (`p.text("status", { enum: STATUSES })`), so the column type and the const
// cannot drift. The paired `p.check(...)` list is plain SQL text, and a
// hand-written copy of the same values drifts silently: adding a member to the
// const still typechecks, the column still accepts it, and the insert fails at
// runtime on the constraint the const never touched. Deriving the list closes
// the gap at its source, so a new member reaches the constraint and the column
// together.
//
// Flagged (a fully quoted list inside a `check(...)` template):
//   p.check("t_status_check", sql`${t.status} IN ('active', 'archived')`)
//   p.check("t_kind_check", sql`kind in ('task','deadline')`)
//
// Allowed (the list comes from the const):
//   p.check(
//     "t_status_check",
//     sql`${t.status} IN (${sql.join(
//       STATUSES.map((status) => sql.raw(`'${status}'`)),
//       sql`, `,
//     )})`,
//   )
//
// The rendered SQL has to stay byte-identical to what the migrations already
// created, so the separator carries the original spacing: `sql`, `` for
// `('a', 'b')` and `sql.raw(",")` for `('a','b')`.
//
// A list is only flagged when every element is a quoted literal and the
// closing paren sits in the same static chunk. A list that already
// interpolates (`IN ('a', ${extra})`) is left alone: it is not a mirror of one
// const, and the rule cannot tell which part should derive from what.
//
// Deliberate subsets (`status IN ('completed', 'cancelled')` inside a larger
// state predicate) are the one legitimate hand-written list. Prefer a named
// subset const derived from the full union; where that does not read cleanly,
// suppress with `// eslint-disable-next-line` plus the reason.

import { eslintCompatPlugin } from "@oxlint/plugins";

// Postgres treats comments as whitespace, so they are blanked before matching;
// otherwise a commented-out list would be reported and a comment could split a
// real one.
const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

// `IN ('a', 'b', ...)` where every element is a quoted literal and the list
// closes in the same chunk. Case-insensitive because both spellings are in use
// (`IN` and `in`), and `''` is Postgres's escape for a quote inside a literal.
const LITERAL_IN_LIST =
  /\bin\s*\(\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\)/iu;

const carriesLiteralEnumList = (raw: string): boolean =>
  LITERAL_IN_LIST.test(raw.replace(SQL_COMMENT, " "));

const isCheckCall = (node): boolean => {
  const { callee } = node;
  if (callee?.type === "Identifier") {
    return callee.name === "check";
  }
  return (
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    callee.property?.type === "Identifier" &&
    callee.property.name === "check"
  );
};

// A quasi's `value` is a plain `{ raw, cooked }` record, not an AST node.
const rawTextOf = (quasi): string => {
  const raw = quasi?.value?.raw;
  return typeof raw === "string" ? raw : "";
};

export default eslintCompatPlugin({
  meta: { name: "require-derived-check-enum" },
  rules: {
    "require-derived-check-enum": {
      meta: {
        type: "problem",
        messages: {
          handWrittenEnumList:
            "Derive this check constraint's enum list from the const the " +
            "column already uses: interpolate a sql.join over the const " +
            "instead of writing the values out. A hand-written copy drifts " +
            "when the const gains a member: the column accepts the new value " +
            "and the insert fails on the constraint at runtime. For a " +
            "deliberate subset, name a subset const or suppress with a reason.",
        },
        schema: [],
      },
      createOnce(context) {
        const reportLiteralLists = (node) => {
          if (node === null || typeof node !== "object") {
            return;
          }
          if (Array.isArray(node)) {
            for (const child of node) {
              reportLiteralLists(child);
            }
            return;
          }
          if (typeof node.type !== "string") {
            return;
          }
          if (node.type === "TemplateLiteral") {
            for (const quasi of node.quasis ?? []) {
              if (carriesLiteralEnumList(rawTextOf(quasi))) {
                context.report({
                  node: quasi,
                  messageId: "handWrittenEnumList",
                });
              }
            }
          }
          for (const key of Object.keys(node)) {
            if (key === "parent" || key === "loc" || key === "range") {
              continue;
            }
            reportLiteralLists(node[key]);
          }
        };

        return {
          CallExpression(node) {
            if (!isCheckCall(node)) {
              return;
            }
            reportLiteralLists(node.arguments);
          },
        };
      },
    },
  },
});
