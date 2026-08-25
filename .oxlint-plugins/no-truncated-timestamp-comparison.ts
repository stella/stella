import { eslintCompatPlugin } from "@oxlint/plugins";

// Require an exact-precision form when comparing against a timestamp column.
//
// Postgres stores `timestamptz` at microsecond precision; a JavaScript `Date`
// carries milliseconds. Reading a timestamp column into a `Date` and comparing
// it back therefore compares a truncated value, and every failure is silent:
//
//   - an ascending keyset (`> cursor.createdAt`) re-admits the boundary row on
//     every page, so pagination never terminates;
//   - a descending keyset (`< cursor.createdAt`) skips the rows that share the
//     boundary's millisecond, so they are never served;
//   - an `IS NOT DISTINCT FROM` compare-and-set guard can never match a row
//     whose timestamp came from `now()`, so the guarded write no-ops.
//
// The safe forms all keep the comparison at the column's own precision:
//
//   1. `apps/api/src/lib/db/timestamp-cas.ts` — `timestampCasToken(column)`
//      selects `column::text`, and `timestampMatchesCasToken(column, token)`
//      feeds it back through `::timestamptz`.
//   2. `apps/api/src/lib/db-pagination.ts` — `createTimestampIdCursorCodec`,
//      `pgTimestampCursorValue`, `pgTimestampCursorBoundary`.
//   3. In-database boundary resolution by id, as in `loadChatMessagePage`
//      (`apps/api/src/handlers/chat/message-page.ts`):
//      `(created_at, id) < (select b.created_at, b.id from t b where b.id = $1)`.
//      The boundary never leaves the database, so nothing can truncate it.
//
// Like no-bare-jsonb-cast, this rule flags EVERY operand in the dangerous
// position rather than trying to decide whether a particular value is safe.
// Whether a `Date` round-tripped through the database cannot be known from one
// file: it arrives through a cursor codec, a helper parameter, an alias, or a
// row read three call frames away. Requiring the safe form unconditionally is
// what makes the guard sound; inferring the producer would only catch the
// obvious cases, and this bug class has already survived a documented
// convention, purpose-built helpers, and two rounds of hand review.
//
// The dangerous position is anchored on a timestamp column, recognised by the
// schema's naming convention (a property or SQL identifier ending in `At` /
// `_at`, plus the handful of columns in EXTRA_TIMESTAMP_COLUMN_NAMES that
// predate it). Drizzle comparisons check either argument. Raw SQL checks the
// conventional column-on-the-left form and the unambiguous reversed form where
// a non-column interpolation is compared against a timestamp member.
//
// Flagged — raw SQL templates:
//   sql`(${t.createdAt}, ${t.id}) > (${cursor.createdAt}, ${cursor.id})`
//   sql`${t.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`
//   sql`${t.createdAt} <= ${cutoff}`
//   sql`created_at > ${cursor.createdAt}`     // column named in the SQL text
//
// Flagged — Drizzle comparison calls:
//   gt(docxSuggestions.createdAt, cursor.createdAt)
//   lt(apikey.createdAt, cursor.createdAt)
//   eq(styleSets.deletedAt, deleted.deletedAt)
//   lte(caseLawDecisions.createdAt, checkpoint.snapshotAt)
//
// Allowed — raw SQL templates:
//   sql`${t.createdAt} > ${token}::timestamptz`        // explicit cast
//   sql`${t.createdAt} <= (${v}::timestamp AT TIME ZONE 'UTC')` // re-anchor
//   sql`(${t.createdAt}, ${t.id}) < (${pgTimestampCursorBoundary(c)}, ${id})`
//   sql`(${t.createdAt}, ${t.id}) < (select b.created_at, b.id from t b
//        where b.id = ${boundaryId})`                  // boundary stays in-DB
//
// Allowed — Drizzle comparison calls:
//   lt(runs.claimedAt, new Date(Date.now() - STALE_MS))  // fresh clock read
//   lte(jobs.nextRunAt, now)          // `const now = new Date()` in this file
//   lte(sources.leaseExpiresAt, sql`now()`)              // compared in-DB
//   lt(decisions.createdAt, pgTimestampCursorBoundary(cursor))
//   gte(table.settledAt, table.cleanupStartedAt)          // same schema owner
//
// A comparison against a clock-derived cutoff is the one exemption resolved
// from syntax rather than from a name: an inequality against a moving cutoff
// does not care about sub-millisecond drift, and a value whose initializer
// literally reads the clock never round-tripped through the database. The
// exemption follows a `const` binding one hop within the file (that is still
// syntax, not inference); a parameter, an import, or a `let` is not provably a
// clock read and stays flagged. Everything else that is genuinely fine takes a
// one-line disable comment stating why, or a named `allowedOperandCalls` entry
// for a helper that emits its own cast.

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

// ── Timestamp column naming ──────────────────────────────────────────────
//
// Every timestamp column in the schema is `timestamptz` (see
// require-timestamptz-column) and all but a handful are named `<verb>At` /
// `<verb>_at`. The exceptions below are the columns that predate the
// convention (better-auth's tables and the billing period bounds); they are
// listed by name because a rule cannot read the schema. Adding a timestamp
// column whose name breaks the convention makes it invisible here, which is
// the reason to keep naming new ones `...At`.
const EXTRA_TIMESTAMP_COLUMN_NAMES = [
  "authTime",
  "cleanupNotBefore",
  "currentPeriodEnd",
  "currentPeriodStart",
  "lastRequest",
  "lockedUntil",
  "periodEnd",
  "periodStart",
  "revoked",
];

const toSnakeCase = (name: string): string =>
  name.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const EXTRA_TIMESTAMP_COLUMN_SPELLINGS = new Set(
  EXTRA_TIMESTAMP_COLUMN_NAMES.flatMap((name) => [
    name.toLowerCase(),
    toSnakeCase(name).toLowerCase(),
  ]),
);

// Both spellings of the convention: the TypeScript property (`createdAt`) and
// the SQL identifier it maps to (`created_at`, matched case-insensitively
// because Postgres folds unquoted identifiers).
const isTimestampColumnName = (name: string): boolean =>
  name.endsWith("At") ||
  name.toLowerCase().endsWith("_at") ||
  EXTRA_TIMESTAMP_COLUMN_SPELLINGS.has(name.toLowerCase());

// A non-computed member access whose property names a timestamp column:
// `caseLawDecisions.createdAt`, `chatMessages.updatedAt`. The object is not
// checked — `cursor.createdAt` has the same shape, and that ambiguity is why
// only the LEFT operand anchors the dangerous position.
const isTimestampColumnExpression = (node: unknown): boolean => {
  if (
    !isAstNode(node) ||
    node.type !== "MemberExpression" ||
    node.computed === true
  ) {
    return false;
  }
  const { property } = node;
  if (!isAstNode(property) || property.type !== "Identifier") {
    return false;
  }
  const name = property.name;
  return typeof name === "string" && isTimestampColumnName(name);
};

const timestampColumnOwner = (node: unknown): AstNode | undefined => {
  if (!isTimestampColumnExpression(node) || !isAstNode(node)) {
    return undefined;
  }
  const { object } = node;
  if (!isAstNode(object) || object.type !== "Identifier") {
    return undefined;
  }
  return typeof object.name === "string" ? object : undefined;
};

// ── SQL text ─────────────────────────────────────────────────────────────

// Postgres treats comments as whitespace wherever they appear, so they are
// replaced before any matching; otherwise a comment could hide the operator
// or the cast that decides the verdict.
const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

const stripSqlComments = (raw: string): string => raw.replace(SQL_COMMENT, " ");

// A comparison operator immediately before the interpolation, optionally
// followed by an opening paren (`= (`). Longest spellings first so `>=` is
// not read as a `>` followed by an `=` operand.
const SYMBOL_COMPARISON_OPERATORS = ["<>", "!=", ">=", "<=", "=", ">", "<"];
const DISTINCT_FROM_OPERATOR = /\bis\s+(?:not\s+)?distinct\s+from$/iu;

type ComparisonOperatorMatch = {
  index: number;
  operator: string;
};

const findComparisonOperator = (
  text: string,
): ComparisonOperatorMatch | undefined => {
  const trimmed = text.trimEnd();
  const candidate = trimmed.endsWith("(")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  for (const operator of SYMBOL_COMPARISON_OPERATORS) {
    if (candidate.endsWith(operator)) {
      return { index: candidate.length - operator.length, operator };
    }
  }
  const distinctFrom = DISTINCT_FROM_OPERATOR.exec(candidate);
  if (distinctFrom === null) {
    return undefined;
  }
  return { index: distinctFrom.index, operator: distinctFrom[0] };
};

// The whole quasi between two row tuples: `) > (`. Anything else between the
// tuples (a subselect, a function call) is not this shape and is left alone —
// the in-database boundary form deliberately reads that way.
const TUPLE_COMPARISON = /^\s*\)\s*(?:<>|!=|>=|<=|=|>|<)\s*\(\s*$/u;

// `=` is a comparison in a predicate and an assignment in an UPDATE's SET
// list, and only the first can truncate. The clause is decided by whichever
// keyword the statement most recently opened: after `SET` the `=` assigns,
// after `WHERE`/`ON`/`HAVING`/`RETURNING` it compares.
const SET_CLAUSE_KEYWORD = /\bset\b/giu;
const PREDICATE_CLAUSE_KEYWORD = /\b(?:where|on|having|returning)\b/giu;

const lastMatchIndex = (text: string, pattern: RegExp): number => {
  pattern.lastIndex = 0;
  let last = -1;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    last = match.index;
  }
  return last;
};

const isAssignmentClause = (precedingSql: string): boolean =>
  lastMatchIndex(precedingSql, SET_CLAUSE_KEYWORD) >
  lastMatchIndex(precedingSql, PREDICATE_CLAUSE_KEYWORD);

// The trailing SQL identifier before a comparison operator, quoted or not, so
// `created_at > ${x}` is recognised without an interpolated column.
const IDENTIFIER_CHARACTER = /[\w$]/u;

const trailingNameIsTimestampColumn = (head: string): boolean => {
  const trimmed = head.trimEnd();
  if (trimmed.endsWith('"')) {
    const start = trimmed.lastIndexOf('"', trimmed.length - 2);
    return start !== -1 && isTimestampColumnName(trimmed.slice(start + 1, -1));
  }
  let start = trimmed.length;
  while (start > 0 && IDENTIFIER_CHARACTER.test(trimmed.at(start - 1) ?? "")) {
    start -= 1;
  }
  return start < trimmed.length && isTimestampColumnName(trimmed.slice(start));
};

// An explicit cast that keeps the operand at the column's precision:
// `::timestamptz` in any spelling Postgres resolves to that type, or the
// deliberate `::timestamp AT TIME ZONE '...'` re-anchor that
// no-naive-timestamp-cast also sanctions.
const TIMESTAMPTZ_TYPE = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?timestamptz\b"?`;
const EXPLICIT_TIMESTAMP_CAST = new RegExp(
  String.raw`^\s*(?:::\s*${TIMESTAMPTZ_TYPE}|::\s*"?timestamp\b"?(?:\s*\(\s*\d+\s*\))?\s+at\s+time\s+zone\b)`,
  "iu",
);
const EXPLICIT_NON_TIMESTAMP_CAST = /^\s*::\s*interval\b/iu;

// A quasi's `value` is a plain `{ raw, cooked }` record, not an AST node, so
// it carries no `type` to narrow on. Prefer the cooked text: an escape like
// `\n` reaches the SQL tag as a real newline, which `\s` matches.
const rawTextOf = (quasi: unknown): string => {
  if (!isAstNode(quasi)) {
    return "";
  }
  const { value } = quasi;
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const cooked = Reflect.get(value, "cooked");
  const raw = Reflect.get(value, "raw");
  if (typeof cooked === "string") {
    return cooked;
  }
  return typeof raw === "string" ? raw : "";
};

// Walk back from the `) OP (` quasi over the left tuple's elements to the one
// that opens it, so an n-element tuple resolves its first (timestamp) slot.
const leftTupleFirstIndex = (
  quasis: unknown[],
  comparisonIndex: number,
): number | undefined => {
  for (let element = comparisonIndex - 1; element >= 0; element -= 1) {
    const before = stripSqlComments(rawTextOf(quasis[element]));
    if (/\(\s*$/u.test(before)) {
      return element;
    }
    if (!/^\s*,\s*$/u.test(before)) {
      return undefined;
    }
  }
  return undefined;
};

// ── Operands the rule accepts on either side ─────────────────────────────

const calleeName = (node: unknown): string | undefined => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return undefined;
  }
  const { callee } = node;
  if (!isAstNode(callee)) {
    return undefined;
  }
  if (callee.type === "Identifier") {
    const name = callee.name;
    return typeof name === "string" ? name : undefined;
  }
  if (callee.type === "MemberExpression" && callee.computed !== true) {
    const { property } = callee;
    if (isAstNode(property) && property.type === "Identifier") {
      const name = property.name;
      return typeof name === "string" ? name : undefined;
    }
  }
  return undefined;
};

// Recognise a Drizzle `sql` tag. A static fragment is database-native, but a
// tag alone is not a safety proof: `sql\`${cursor.createdAt}\`` still binds a
// truncated Date. The recursive check in `create` inspects its expressions.
const isSqlTaggedTemplate = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "TaggedTemplateExpression") {
    return false;
  }
  const { tag } = node;
  if (!isAstNode(tag)) {
    return false;
  }
  if (tag.type === "Identifier") {
    return tag.name === "sql";
  }
  if (tag.type === "MemberExpression" && tag.computed !== true) {
    const { property } = tag;
    return (
      isAstNode(property) &&
      property.type === "Identifier" &&
      property.name === "sql"
    );
  }
  return false;
};

const isIdentifierNamed = (node: unknown, name: string): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === name;

const isDateNowCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const { callee } = node;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifierNamed(callee.object, "Date") &&
    isIdentifierNamed(callee.property, "now") &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 0
  );
};

const isClockAdjustment = (node: unknown): boolean =>
  isAstNode(node) &&
  (node.type === "Literal" ||
    node.type === "Identifier" ||
    (node.type === "UnaryExpression" && isClockAdjustment(node.argument)) ||
    (node.type === "BinaryExpression" &&
      (node.operator === "+" ||
        node.operator === "-" ||
        node.operator === "*" ||
        node.operator === "/") &&
      isClockAdjustment(node.left) &&
      isClockAdjustment(node.right)));

const isClockArithmetic = (node: unknown): boolean => {
  if (isDateNowCall(node)) {
    return true;
  }
  if (!isAstNode(node) || node.type !== "BinaryExpression") {
    return false;
  }
  const operator = node.operator;
  if (
    operator !== "+" &&
    operator !== "-" &&
    operator !== "*" &&
    operator !== "/"
  ) {
    return false;
  }
  return (
    (isClockArithmetic(node.left) && isClockAdjustment(node.right)) ||
    (isClockAdjustment(node.left) && isClockArithmetic(node.right))
  );
};

// The entire operand, not merely one branch or nested subexpression, must be
// a fresh clock read. A substring test would incorrectly exempt
// `cursor.createdAt ?? new Date()` and re-open the truncation bug.
const isFreshClockRead = (node: unknown): boolean => {
  if (isDateNowCall(node)) {
    return true;
  }
  if (!isAstNode(node) || node.type !== "NewExpression") {
    return false;
  }
  if (
    !isIdentifierNamed(node.callee, "Date") ||
    !Array.isArray(node.arguments)
  ) {
    return false;
  }
  return (
    node.arguments.length === 0 ||
    (node.arguments.length === 1 && isClockArithmetic(node.arguments[0]))
  );
};

// Drizzle's scalar comparison builders. `isNull`/`isNotNull` are absent
// because they bind no value; `between` is absent because nothing in this
// codebase applies it to a timestamp column — add it here if that changes.
const DRIZZLE_COMPARISONS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);

const configuredAllowedOperandCalls = (options: unknown): unknown[] => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return [];
  }
  const calls = Reflect.get(options, "allowedOperandCalls");
  return Array.isArray(calls) ? calls : [];
};

export default eslintCompatPlugin({
  meta: { name: "no-truncated-timestamp-comparison" },
  rules: {
    "no-truncated-timestamp-comparison": {
      meta: {
        type: "problem",
        messages: {
          truncatedTimestampComparison:
            "Compare a timestamp column at its own precision. Postgres stores " +
            "microseconds and a JS Date carries milliseconds, so comparing a " +
            "round-tripped Date silently re-admits or skips the boundary row " +
            "and makes an IS NOT DISTINCT FROM guard a no-op. Use " +
            "createTimestampIdCursorCodec / pgTimestampCursorBoundary, " +
            "timestampCasToken / timestampMatchesCasToken, resolve the " +
            "boundary in-database by id, or cast the operand `::timestamptz`. " +
            "A cutoff read straight from the clock (new Date() / Date.now()) " +
            "is exempt; anything else that is sound needs a disable comment " +
            "saying why.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedOperandCalls: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const allowedOperandCalls = new Set<string>();

        // Resolve the `Variable` an Identifier binds to by walking the scope
        // chain outward from its use site (this plugin API has no ready-made
        // `findVariable`; mirrors require-function-replacer.ts).
        const resolveVariable = (identifier) => {
          const findVariable = (scope) =>
            scope?.set.get(identifier.name) ??
            (scope?.upper ? findVariable(scope.upper) : null);
          return findVariable(context.sourceCode.getScope(identifier));
        };

        const isPgTableCall = (node: unknown): boolean =>
          isAstNode(node) &&
          node.type === "CallExpression" &&
          calleeName(node) === "pgTable";

        // The same spelling on both operands is not enough: a helper object
        // can group a real column and a round-tripped Date under one owner.
        // Accept the exemption only when that owner resolves to a pgTable
        // binding or to the table parameter of pgTable's checks callback.
        const isPgTableOwner = (owner: AstNode): boolean => {
          const variable = resolveVariable(owner);
          return (
            variable !== null &&
            variable.defs.some((def) => {
              if (def.type === "Variable" && isAstNode(def.node)) {
                return (
                  def.node.type === "VariableDeclarator" &&
                  isPgTableCall(def.node.init)
                );
              }
              if (def.type !== "Parameter" || !isAstNode(def.node)) {
                return false;
              }
              return isPgTableCall(def.node.parent);
            })
          );
        };

        const hasSameTimestampColumnOwner = (
          left: unknown,
          right: unknown,
        ): boolean => {
          const leftOwner = timestampColumnOwner(left);
          const rightOwner = timestampColumnOwner(right);
          if (
            leftOwner === undefined ||
            rightOwner === undefined ||
            leftOwner.name !== rightOwner.name
          ) {
            return false;
          }
          return isPgTableOwner(leftOwner) && isPgTableOwner(rightOwner);
        };

        // One hop from an identifier to the `const` initializer it was bound
        // to in this file. `let`/`var` can be reassigned and a parameter or an
        // import has no initializer here, so neither is provably a clock read.
        const bindsToClockRead = (node: unknown): boolean => {
          if (
            !isAstNode(node) ||
            node.type !== "Identifier" ||
            typeof node.name !== "string"
          ) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null) {
            return false;
          }
          return variable.defs.some((def) => {
            if (def.type !== "Variable" || !isAstNode(def.node)) {
              return false;
            }
            if (def.node.type !== "VariableDeclarator") {
              return false;
            }
            if (
              !isAstNode(def.parent) ||
              def.parent.type !== "VariableDeclaration" ||
              def.parent.kind !== "const"
            ) {
              return false;
            }
            return isFreshClockRead(def.node.init);
          });
        };

        const isSafeSqlFragment = (node: unknown): boolean => {
          if (!isSqlTaggedTemplate(node) || !isAstNode(node)) {
            return false;
          }
          const { quasi } = node;
          if (!isAstNode(quasi) || quasi.type !== "TemplateLiteral") {
            return false;
          }
          const expressions = Array.isArray(quasi.expressions)
            ? quasi.expressions
            : [];
          const quasis = Array.isArray(quasi.quasis) ? quasi.quasis : [];
          const staticSql = stripSqlComments(quasis.map(rawTextOf).join(" "));
          const selected =
            /\bselect\s+(?:(?:"?[\w$]+"?)\s*\.\s*)?"?(?<name>[\w$]+)"?/iu.exec(
              staticSql,
            );
          if (
            selected?.groups?.name !== undefined &&
            isTimestampColumnName(selected.groups.name)
          ) {
            return true;
          }
          return expressions.every((expression, index) => {
            if (
              EXPLICIT_TIMESTAMP_CAST.test(
                stripSqlComments(rawTextOf(quasis[index + 1])),
              ) ||
              EXPLICIT_NON_TIMESTAMP_CAST.test(
                stripSqlComments(rawTextOf(quasis[index + 1])),
              )
            ) {
              return true;
            }
            const callee = calleeName(expression);
            return (
              (callee !== undefined && allowedOperandCalls.has(callee)) ||
              isFreshClockRead(expression) ||
              bindsToClockRead(expression) ||
              isSafeSqlFragment(expression)
            );
          });
        };

        const bindsToSafeSqlFragment = (node: unknown): boolean => {
          if (
            !isAstNode(node) ||
            node.type !== "Identifier" ||
            typeof node.name !== "string"
          ) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null) {
            return false;
          }
          return variable.defs.some(
            (def) =>
              def.type === "Variable" &&
              isAstNode(def.node) &&
              def.node.type === "VariableDeclarator" &&
              isAstNode(def.parent) &&
              def.parent.type === "VariableDeclaration" &&
              def.parent.kind === "const" &&
              isSafeSqlFragment(def.node.init),
          );
        };

        const isAllowedOperand = (node: unknown): boolean => {
          if (isSqlTaggedTemplate(node)) {
            return isSafeSqlFragment(node);
          }
          const callee = calleeName(node);
          if (callee !== undefined && allowedOperandCalls.has(callee)) {
            return true;
          }
          if (isFreshClockRead(node)) {
            return true;
          }
          return bindsToClockRead(node) || bindsToSafeSqlFragment(node);
        };

        const report = (node) => {
          context.report({
            node,
            messageId: "truncatedTimestampComparison",
          });
        };

        // ── Family A: raw SQL templates ──────────────────────────────────
        //
        // True when the operand interpolated at `index` sits on the right of
        // a comparison whose left operand is a timestamp column.
        const isTimestampComparisonSlot = (
          quasis: unknown[],
          expressions: unknown[],
          index: number,
          precedingSql: string,
        ): boolean => {
          const before = stripSqlComments(rawTextOf(quasis[index]));

          // `(${t.createdAt}, ${t.id}) > (${boundary}, ${id})`: this
          // interpolation is the right tuple's first slot.
          if (TUPLE_COMPARISON.test(before)) {
            const first = leftTupleFirstIndex(quasis, index);
            return (
              first !== undefined &&
              isTimestampColumnExpression(expressions[first])
            );
          }

          const match = findComparisonOperator(before);
          if (match === undefined) {
            return false;
          }
          // `SET indexed_at = ${value}` writes the column; it does not read it
          // back, so nothing is truncated.
          if (match.operator === "=" && isAssignmentClause(precedingSql)) {
            return false;
          }
          const head = before.slice(0, match.index);
          // Nothing before the operator: the left operand is the previous
          // interpolation (`${t.updatedAt} IS NOT DISTINCT FROM ${token}`).
          if (head.trim() === "") {
            return isTimestampColumnExpression(expressions[index - 1]);
          }
          // Otherwise the column is written in the SQL text itself
          // (`created_at > ${cursor}`).
          return trailingNameIsTimestampColumn(head);
        };

        return {
          before() {
            allowedOperandCalls.clear();
            for (const call of configuredAllowedOperandCalls(
              context.options[0],
            )) {
              if (typeof call === "string") {
                allowedOperandCalls.add(call);
              }
            }
          },
          TemplateLiteral(node) {
            const expressions = Array.isArray(node.expressions)
              ? node.expressions
              : [];
            const quasis = Array.isArray(node.quasis) ? node.quasis : [];

            // Statement text up to (and including) each interpolation's own
            // quasi, so the SET-vs-WHERE clause of an `=` can be decided.
            let precedingSql = "";
            for (const [index, expression] of expressions.entries()) {
              precedingSql += stripSqlComments(rawTextOf(quasis[index]));

              // `${boundary} < ${table.createdAt}`: the timestamp column is
              // on the right, so the unsafe operand is the previous
              // interpolation. The normal slot check below covers the common
              // column-on-the-left form.
              const before = stripSqlComments(rawTextOf(quasis[index]));
              const reversedMatch = findComparisonOperator(before);
              const reversedHead =
                reversedMatch === undefined
                  ? ""
                  : before.slice(0, reversedMatch.index);
              const reversedOperand =
                reversedMatch !== undefined &&
                reversedHead.trim() === "" &&
                isTimestampColumnExpression(expression) &&
                !isTimestampColumnExpression(expressions[index - 1])
                  ? expressions[index - 1]
                  : undefined;
              if (
                reversedOperand !== undefined &&
                !isAllowedOperand(reversedOperand)
              ) {
                report(reversedOperand);
              }

              if (
                !isTimestampComparisonSlot(
                  quasis,
                  expressions,
                  index,
                  precedingSql,
                )
              ) {
                continue;
              }
              const comparison = findComparisonOperator(before);
              const comparisonHead =
                comparison === undefined
                  ? ""
                  : before.slice(0, comparison.index);
              const tupleFirst = TUPLE_COMPARISON.test(before)
                ? leftTupleFirstIndex(quasis, index)
                : undefined;
              const leftComparisonOperand =
                tupleFirst !== undefined
                  ? expressions[tupleFirst]
                  : comparison !== undefined && comparisonHead.trim() === ""
                    ? expressions[index - 1]
                    : undefined;
              if (
                leftComparisonOperand !== undefined &&
                hasSameTimestampColumnOwner(leftComparisonOperand, expression)
              ) {
                continue;
              }
              // An explicit cast on the SQL side keeps the operand at full
              // precision whatever produced it.
              if (
                EXPLICIT_TIMESTAMP_CAST.test(
                  stripSqlComments(rawTextOf(quasis[index + 1])),
                )
              ) {
                continue;
              }
              if (isAllowedOperand(expression)) {
                continue;
              }
              report(expression);
            }
          },

          // ── Family B: Drizzle comparison calls ────────────────────────
          //
          // `eq`/`ne`/`gt`/`gte`/`lt`/`lte` with a timestamp column on one
          // side. This is the shape that produced every recent regression:
          // the column reads as a column, and the operand reads as an
          // innocuous `cursor.createdAt`.
          CallExpression(node) {
            const callee = calleeName(node);
            if (callee === undefined || !DRIZZLE_COMPARISONS.has(callee)) {
              return;
            }
            const args = Array.isArray(node.arguments) ? node.arguments : [];
            if (args.length !== 2) {
              return;
            }
            const [left, right] = args;
            if (
              !isAstNode(left) ||
              !isAstNode(right) ||
              left.type === "SpreadElement" ||
              right.type === "SpreadElement"
            ) {
              return;
            }

            // The column can be written on either side; the other argument is
            // the operand that must carry the safe form.
            const operand = isTimestampColumnExpression(left)
              ? right
              : isTimestampColumnExpression(right)
                ? left
                : undefined;
            if (
              operand === undefined ||
              hasSameTimestampColumnOwner(left, right) ||
              isAllowedOperand(operand)
            ) {
              return;
            }
            report(operand);
          },
        };
      },
    },
  },
});
