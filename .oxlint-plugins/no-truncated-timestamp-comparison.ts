import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, resolveVariable } from "./utils.ts";
import type { AstNode } from "./utils.ts";

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
// Flagged — a timestamp compared as text, whatever the operand (its own
// message points at timestampMatchesCasToken), in every spelling of the cast:
//   sql`${t.updatedAt}::text = ${token}`
//   sql`${token} = ${t.updatedAt}::text`
//   sql`(${t.updatedAt})::varchar <> ${token}`
//   sql`CAST(${t.updatedAt} AS text) = ${token}`
//   sql`to_char(${t.updatedAt}, 'YYYY-MM-DD HH24:MI:SS.US') = ${token}`
//   sql`${timestampCasToken(t.updatedAt)} = ${token}`
//   sql`${t.updatedAt}::text IN (${a}, ${b})`
//   sql`${token} = CAST(updated_at AS text)`  // column named in the SQL text
//   eq(timestampCasToken(t.updatedAt), token)
//   inArray(sql`${t.updatedAt}::text`, tokens)
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
//   lt(runs.claimedAt, new Date(Temporal.Now.instant().epochMilliseconds - STALE_MS))
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

// A cast to a character type. `timestamptz::text` prints the instant in the
// session's TimeZone and DateStyle, so a comparison of that text can refuse
// the very instant it was read from once either setting differs.
const TEXT_TYPE = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?(?:text|varchar|bpchar|char|character(?:\s+varying)?)\b"?(?:\s*\(\s*\d+\s*\))?`;
const LEADING_TEXT_CAST = new RegExp(String.raw`^\s*::\s*${TEXT_TYPE}`, "iu");

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

const TEMPORAL_MODULES = new Set(["@stll/time", "temporal-polyfill/full"]);

type ClockReadPredicate = (node: unknown) => boolean;

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

const isClockArithmetic = (
  node: unknown,
  isClockRead: ClockReadPredicate,
): boolean => {
  if (isClockRead(node)) {
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
    (isClockArithmetic(node.left, isClockRead) &&
      isClockAdjustment(node.right)) ||
    (isClockAdjustment(node.left) && isClockArithmetic(node.right, isClockRead))
  );
};

// The entire operand, not merely one branch or nested subexpression, must be
// a fresh clock read. A substring test would incorrectly exempt
// `cursor.createdAt ?? new Date()` and re-open the truncation bug.
const isFreshClockRead = (
  node: unknown,
  isClockRead: ClockReadPredicate,
): boolean => {
  if (isClockRead(node)) {
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
    (node.arguments.length === 1 &&
      isClockArithmetic(node.arguments[0], isClockRead))
  );
};

// Drizzle's scalar comparison builders. `isNull`/`isNotNull` are absent
// because they bind no value; `between` is absent because nothing in this
// codebase applies it to a timestamp column — add it here if that changes.
const DRIZZLE_COMPARISONS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);

// Drizzle's list membership builders; a timestamp's text in the list position
// compares exactly like `eq`.
const DRIZZLE_LIST_COMPARISONS = new Set(["inArray", "notInArray"]);

// ── A timestamp rendered as text ─────────────────────────────────────────
//
// Every spelling Postgres accepts for turning a timestamp into text prints it
// in the session's TimeZone and DateStyle (or a caller's format), so each is
// the same hazard: `col::text`, `(col)::text`, `CAST(col AS text)`,
// `to_char(col, …)`, and the token helper `timestampCasToken(col)` itself.
const CAST_OPEN = /\bcast\s*\(\s*$/iu;
const TO_CHAR_OPEN = /\bto_char\s*\(\s*$/iu;
const CAST_TEXT_CLOSE = new RegExp(
  String.raw`^\s*as\s+${TEXT_TYPE}\s*\)`,
  "iu",
);
const TO_CHAR_CLOSE = /^\s*,[^()]*\)/u;
const PAREN_TEXT_CAST = new RegExp(
  String.raw`^\s*\)\s*::\s*${TEXT_TYPE}`,
  "iu",
);

// A SQL identifier, qualified or quoted: `updated_at`, `t."updatedAt"`.
const SQL_NAME = String.raw`[\w$."]+`;
// The same renderings written around a column named in the SQL text.
const NAMED_TIMESTAMP_TEXT = new RegExp(
  [
    String.raw`\bcast\s*\(\s*(?<cast>${SQL_NAME})\s+as\s+${TEXT_TYPE}\s*\)`,
    String.raw`\bto_char\s*\(\s*(?<format>${SQL_NAME})\s*,[^()]*\)`,
    String.raw`\(\s*(?<paren>${SQL_NAME})\s*\)\s*::\s*${TEXT_TYPE}`,
    String.raw`(?<plain>${SQL_NAME})\s*::\s*${TEXT_TYPE}`,
  ].join("|"),
  "giu",
);

// An operator that compares the text right after a rendering: the scalar
// comparisons, `IS [NOT] DISTINCT FROM`, list membership and pattern matches.
const LEADING_TEXT_COMPARISON =
  /^\s*(?<operator><>|!=|>=|<=|=(?!>)|>|<|is\s+(?:not\s+)?distinct\s+from\b|(?:not\s+)?(?:in|i?like)\b)/iu;

// What the rendered text may pass through on its way to the operator and
// still be the same text: a collation, a concatenation with a literal or a
// name, and a grouping paren or text function around it, closed by `)` or by
// the rest of the function's argument list.
const SQL_OPERAND = String.raw`(?:'(?:[^']|'')*'|"[^"]*"|[\w$.]+)`;
// A text function's opening, or a grouping paren that follows no name.
const TEXT_OPENER_END =
  /(?:\b(?:coalesce|lower|upper|btrim|ltrim|rtrim|trim|concat)\s*\(|(?<![\w$"]\s*)\()\s*$/iu;
const CONCAT_BEFORE_END = new RegExp(
  String.raw`${SQL_OPERAND}\s*\|\|\s*$`,
  "iu",
);
const CLOSER_START = new RegExp(
  String.raw`^\s*(?:,\s*${SQL_OPERAND}\s*)*\)`,
  "iu",
);
const TEXT_SUFFIX_START = new RegExp(
  String.raw`^\s*(?:collate\s+${SQL_OPERAND}|\|\|\s*${SQL_OPERAND})`,
  "iu",
);
// Bounds the stripping; a deeper nesting is not a spelling worth chasing.
const MAX_PASSTHROUGH_STEPS = 8;

/**
 * The SQL text around a rendering with every pass-through stripped: what
 * stands right before it and right after it once the rendered text has gone
 * through its wrappers. A `)` is stripped only for an opener stripped before,
 * so `length(col::text) = 10` still compares a number.
 */
const unwrapRenderedText = (
  before: string,
  after: string,
): { before: string; after: string } => {
  let head = before;
  let opened = 0;
  for (let step = 0; step < MAX_PASSTHROUGH_STEPS; step += 1) {
    const opener = TEXT_OPENER_END.exec(head);
    if (opener !== null) {
      opened += 1;
      head = head.slice(0, opener.index);
      continue;
    }
    const concat = CONCAT_BEFORE_END.exec(head);
    if (concat === null) {
      break;
    }
    head = head.slice(0, concat.index);
  }
  let tail = after;
  for (let step = 0; step < MAX_PASSTHROUGH_STEPS; step += 1) {
    const closer = opened > 0 ? CLOSER_START.exec(tail) : null;
    if (closer !== null) {
      opened -= 1;
      tail = tail.slice(closer[0].length);
      continue;
    }
    const suffix = TEXT_SUFFIX_START.exec(tail);
    if (suffix === null) {
      break;
    }
    tail = tail.slice(suffix[0].length);
  }
  return { before: head, after: tail };
};

/** How the text family recognises a timestamp column and the token helper;
 * both read the file's bindings, so they are built per file. */
type TextRenderingMatchers = {
  isColumn: (node: unknown) => boolean;
  isTokenCall: (node: unknown) => boolean;
};

// The column a named rendering reads is a timestamp by the naming convention.
const namedRenderingIsTimestamp = (match: RegExpExecArray): boolean => {
  const groups = match.groups ?? {};
  const name =
    groups["cast"] ?? groups["format"] ?? groups["paren"] ?? groups["plain"];
  return name !== undefined && trailingNameIsTimestampColumn(name);
};

// Every named timestamp rendering in `text` with its span.
const namedTimestampRenderings = (
  text: string,
): { start: number; end: number }[] =>
  Array.from(text.matchAll(NAMED_TIMESTAMP_TEXT))
    .filter(namedRenderingIsTimestamp)
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));

type RenderingSpan = {
  /** Length of the rendering's opening at the end of the text before it. */
  open: number;
  /** Length of the rendering's closing at the start of the text after it. */
  close: number;
};

// The SQL text around the interpolation at `index` that belongs to its
// rendering as text (`CAST(` … ` AS text)`, `to_char(` … `, 'YYYY')`,
// `(` … `)::text`, `::text`), or `undefined` when that interpolation is not a
// timestamp rendered as text.
const timestampTextSpan = (
  quasis: unknown[],
  expressions: unknown[],
  index: number,
  matchers: TextRenderingMatchers,
): RenderingSpan | undefined => {
  const expression = expressions[index];
  if (isTimestampTextOperand(expression, matchers)) {
    return { open: 0, close: 0 };
  }
  if (!matchers.isColumn(expression)) {
    return undefined;
  }
  const before = stripSqlComments(rawTextOf(quasis[index]));
  const after = stripSqlComments(rawTextOf(quasis[index + 1]));
  const opener = CAST_OPEN.exec(before) ?? TO_CHAR_OPEN.exec(before);
  if (opener !== null) {
    const close = CAST_OPEN.test(before)
      ? CAST_TEXT_CLOSE.exec(after)
      : TO_CHAR_CLOSE.exec(after);
    return close === null
      ? undefined
      : { open: opener[0].length, close: close[0].length };
  }
  const plain = LEADING_TEXT_CAST.exec(after);
  if (plain !== null) {
    return { open: 0, close: plain[0].length };
  }
  const paren = /\(\s*$/u.exec(before);
  const parenClose = paren === null ? null : PAREN_TEXT_CAST.exec(after);
  return paren === null || parenClose === null
    ? undefined
    : { open: paren[0].length, close: parenClose[0].length };
};

// A Drizzle comparison argument that is a timestamp column's text:
// `timestampCasToken(t.updatedAt)`, or a `sql` fragment that is nothing but
// one rendering such as sql`${t.updatedAt}::text` or
// sql`CAST(${t.updatedAt} AS varchar)`.
const isTimestampTextOperand = (
  node: unknown,
  matchers: TextRenderingMatchers,
): boolean => {
  if (matchers.isTokenCall(node)) {
    return true;
  }
  if (!isSqlTaggedTemplate(node) || !isAstNode(node)) {
    return false;
  }
  const { quasi } = node;
  if (!isAstNode(quasi) || quasi.type !== "TemplateLiteral") {
    return false;
  }
  const expressions = Array.isArray(quasi.expressions) ? quasi.expressions : [];
  const quasis = Array.isArray(quasi.quasis) ? quasi.quasis : [];
  if (expressions.length === 0) {
    const text = stripSqlComments(rawTextOf(quasis[0]));
    const [only, ...others] = namedTimestampRenderings(text);
    return (
      only !== undefined &&
      others.length === 0 &&
      text.slice(0, only.start).trim() === "" &&
      text.slice(only.end).trim() === ""
    );
  }
  if (expressions.length !== 1) {
    return false;
  }
  const opening = stripSqlComments(rawTextOf(quasis[0]));
  const span = timestampTextSpan(quasis, expressions, 0, matchers);
  return (
    span !== undefined &&
    opening.slice(0, opening.length - span.open).trim() === "" &&
    stripSqlComments(rawTextOf(quasis[1])).slice(span.close).trim() === ""
  );
};

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
            "A cutoff read straight from the clock (new Date(), Date.now(), " +
            "or imported Temporal.Now.instant().epochMilliseconds) " +
            "is exempt; anything else that is sound needs a disable comment " +
            "saying why.",
          timestampTextComparison:
            "Do not compare a timestamp column as text. `::text` prints the " +
            "instant in the session's TimeZone and DateStyle, so a token read " +
            "in one session can fail to match the same instant in another. " +
            "Select the token with timestampCasToken(column) and compare it " +
            "with timestampMatchesCasToken(column, token) from " +
            "apps/api/src/lib/db/timestamp-cas.ts.",
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

        const resolveInScope = (identifier) =>
          resolveVariable(context, identifier);

        // ── Bindings the text family follows ────────────────────────────
        //
        // The definitions a local name comes from, one hop: an import, a
        // `const` initializer or a destructured property.
        const definitionsOf = (node: unknown): AstNode[] => {
          if (!isAstNode(node) || node.type !== "Identifier") {
            return [];
          }
          const variable = resolveInScope(node);
          return variable === null
            ? []
            : variable.defs.flatMap((definition) =>
                isAstNode(definition.node) ? [definition.node] : [],
              );
        };

        const propertyKeyName = (key: unknown): string | undefined => {
          if (!isAstNode(key)) {
            return undefined;
          }
          if (key.type === "Identifier" && typeof key.name === "string") {
            return key.name;
          }
          return key.type === "Literal" && typeof key.value === "string"
            ? key.value
            : undefined;
        };

        // The key a destructuring pattern reads into `local`, if any:
        // `const { updatedAt } = t` or `const { updatedAt: at } = t`.
        const destructuredKey = (
          declarator: AstNode,
          local: AstNode,
        ): string | undefined => {
          const pattern = declarator.id;
          if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") {
            return undefined;
          }
          const properties = Array.isArray(pattern.properties)
            ? pattern.properties
            : [];
          for (const property of properties) {
            if (
              isAstNode(property) &&
              property.type === "Property" &&
              isIdentifierNamed(property.value, String(local.name))
            ) {
              return propertyKeyName(property.key);
            }
          }
          return undefined;
        };

        // A timestamp column however the file names it: `t.updatedAt`,
        // `t["updatedAt"]`, or a local bound from one.
        const isTextColumn = (node: unknown): boolean => {
          if (isTimestampColumnExpression(node)) {
            return true;
          }
          if (!isAstNode(node)) {
            return false;
          }
          if (node.type === "MemberExpression" && node.computed === true) {
            const { property } = node;
            return (
              isAstNode(property) &&
              property.type === "Literal" &&
              typeof property.value === "string" &&
              isTimestampColumnName(property.value)
            );
          }
          if (node.type !== "Identifier") {
            return false;
          }
          return definitionsOf(node).some((definition) => {
            if (definition.type !== "VariableDeclarator") {
              return false;
            }
            const key = destructuredKey(definition, node);
            if (key !== undefined) {
              return isTimestampColumnName(key);
            }
            return (
              isAstNode(definition.id) &&
              definition.id.type === "Identifier" &&
              isTimestampColumnExpression(definition.init)
            );
          });
        };

        const TOKEN_HELPER = "timestampCasToken";

        // The token helper however the file reaches it: by name, as a
        // namespace or object member, under an import alias, or through a
        // `const` or destructured binding of it.
        const isTokenHelper = (callee: unknown): boolean => {
          if (
            isIdentifierNamed(callee, TOKEN_HELPER) ||
            isNamedMember(callee, TOKEN_HELPER)
          ) {
            return true;
          }
          if (!isAstNode(callee) || callee.type !== "Identifier") {
            return false;
          }
          return definitionsOf(callee).some((definition) => {
            if (definition.type === "ImportSpecifier") {
              return propertyKeyName(definition.imported) === TOKEN_HELPER;
            }
            if (definition.type !== "VariableDeclarator") {
              return false;
            }
            return (
              destructuredKey(definition, callee) === TOKEN_HELPER ||
              isIdentifierNamed(definition.init, TOKEN_HELPER) ||
              isNamedMember(definition.init, TOKEN_HELPER)
            );
          });
        };

        const textMatchers: TextRenderingMatchers = {
          isColumn: isTextColumn,
          isTokenCall: (node) =>
            isAstNode(node) &&
            node.type === "CallExpression" &&
            isTokenHelper(node.callee),
        };

        const isImportedTemporal = (node: unknown): boolean => {
          if (!isAstNode(node) || node.type !== "Identifier") {
            return false;
          }
          const variable = resolveInScope(node);
          if (variable === null) {
            return false;
          }
          return variable.defs.some((definition) => {
            if (
              definition.type !== "ImportBinding" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "ImportSpecifier" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "ImportDeclaration" ||
              !isAstNode(definition.parent.source) ||
              typeof definition.parent.source.value !== "string" ||
              !TEMPORAL_MODULES.has(definition.parent.source.value)
            ) {
              return false;
            }
            const { imported } = definition.node;
            return (
              isAstNode(imported) &&
              ((imported.type === "Identifier" &&
                imported.name === "Temporal") ||
                (imported.type === "Literal" && imported.value === "Temporal"))
            );
          });
        };

        const isNamedMember = (node: unknown, name: string): boolean =>
          isAstNode(node) &&
          node.type === "MemberExpression" &&
          node.computed !== true &&
          isIdentifierNamed(node.property, name);

        const isTemporalNowEpochMilliseconds = (node: unknown): boolean => {
          if (!isNamedMember(node, "epochMilliseconds") || !isAstNode(node)) {
            return false;
          }
          const instantCall = node.object;
          if (
            !isAstNode(instantCall) ||
            instantCall.type !== "CallExpression" ||
            !Array.isArray(instantCall.arguments) ||
            instantCall.arguments.length !== 0 ||
            !isNamedMember(instantCall.callee, "instant") ||
            !isAstNode(instantCall.callee)
          ) {
            return false;
          }
          const nowMember = instantCall.callee.object;
          return (
            isNamedMember(nowMember, "Now") &&
            isAstNode(nowMember) &&
            isImportedTemporal(nowMember.object)
          );
        };

        const isRecognizedClockRead = (node: unknown): boolean =>
          isDateNowCall(node) || isTemporalNowEpochMilliseconds(node);

        const isFreshClockOperand = (node: unknown): boolean =>
          isFreshClockRead(node, isRecognizedClockRead);

        const isPgTableCall = (node: unknown): boolean =>
          isAstNode(node) &&
          node.type === "CallExpression" &&
          calleeName(node) === "pgTable";

        // The same spelling on both operands is not enough: a helper object
        // can group a real column and a round-tripped Date under one owner.
        // Accept the exemption only when that owner resolves to a pgTable
        // binding or to the table parameter of pgTable's checks callback.
        const isPgTableOwner = (owner: AstNode): boolean => {
          const variable = resolveInScope(owner);
          return (
            variable?.defs.some((def) => {
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
            }) === true
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
          const variable = resolveInScope(node);
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
            return isFreshClockOperand(def.node.init);
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
              isFreshClockOperand(expression) ||
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
          const variable = resolveInScope(node);
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
          if (isFreshClockOperand(node)) {
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

        // ── Family A0: a timestamp compared as text ──────────────────────
        //
        // True when a comparison sits right before or right after `before`
        // and `after`, the SQL text around one timestamp rendering. An `=`
        // in an UPDATE's SET list assigns and compares nothing.
        // A collation, a concatenation or a text function around the
        // rendering leaves it the same text, so they are seen through first.
        const isComparedText = (
          renderingBefore: string,
          renderingAfter: string,
          precedingSql: string,
        ): boolean => {
          const { before, after } = unwrapRenderedText(
            renderingBefore,
            renderingAfter,
          );
          const assigns = (operator: string | undefined) =>
            operator === "=" && isAssignmentClause(precedingSql);
          const leading = findComparisonOperator(before);
          if (leading !== undefined && !assigns(leading.operator)) {
            return true;
          }
          const trailing = LEADING_TEXT_COMPARISON.exec(after);
          return trailing !== null && !assigns(trailing.groups?.["operator"]);
        };

        // True when the interpolation at `index` renders a timestamp column
        // as text in any spelling — `${t.updatedAt}::text`,
        // `(${t.updatedAt})::text`, `CAST(${t.updatedAt} AS varchar)`,
        // `to_char(${t.updatedAt}, …)`, `${timestampCasToken(t.updatedAt)}`
        // — and that text is compared, on either side. No operand form makes
        // this safe, so the other operand is not inspected.
        const isTimestampTextComparison = (
          quasis: unknown[],
          expressions: unknown[],
          index: number,
          precedingSql: string,
        ): boolean => {
          const span = timestampTextSpan(
            quasis,
            expressions,
            index,
            textMatchers,
          );
          if (span === undefined) {
            return false;
          }
          const before = stripSqlComments(rawTextOf(quasis[index]));
          return isComparedText(
            before.slice(0, before.length - span.open),
            stripSqlComments(rawTextOf(quasis[index + 1])).slice(span.close),
            precedingSql,
          );
        };

        // The same renderings written around a column named in the SQL text:
        // `updated_at::text = ${token}`, `${token} = CAST(updated_at AS
        // text)`, `to_char(t.updated_at, 'YYYY') = ${token}`.
        const reportNamedTimestampText = (
          node: unknown,
          quasis: unknown[],
          expressions: unknown[],
        ) => {
          let precedingSql = "";
          for (const [index, quasi] of quasis.entries()) {
            const text = stripSqlComments(rawTextOf(quasi));
            for (const { start, end } of namedTimestampRenderings(text)) {
              if (
                isComparedText(
                  text.slice(0, start),
                  text.slice(end),
                  precedingSql + text.slice(0, start),
                )
              ) {
                context.report({
                  node: expressions[index] ?? expressions[index - 1] ?? node,
                  messageId: "timestampTextComparison",
                });
              }
            }
            precedingSql += text;
          }
        };

        // `sql.raw("updated_at::text = '…'")`: a literal statement is scanned
        // like a template's text. True when `node` is such a call.
        const reportRawStatement = (node: AstNode, args: unknown[]) => {
          if (
            !isAstNode(node.callee) ||
            node.callee.type !== "MemberExpression" ||
            !isIdentifierNamed(node.callee.object, "sql") ||
            !isNamedMember(node.callee, "raw")
          ) {
            return false;
          }
          const [statement] = args;
          const quasi =
            isAstNode(statement) &&
            statement.type === "TemplateLiteral" &&
            Array.isArray(statement.expressions) &&
            statement.expressions.length === 0 &&
            Array.isArray(statement.quasis)
              ? statement.quasis.at(0)
              : undefined;
          const text =
            isAstNode(statement) &&
            statement.type === "Literal" &&
            typeof statement.value === "string"
              ? statement.value
              : stripSqlComments(rawTextOf(quasi));
          if (text !== "") {
            reportNamedTimestampText(
              node,
              [
                {
                  type: "TemplateElement",
                  range: node.range,
                  value: { cooked: text },
                },
              ],
              [],
            );
          }
          return true;
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

            if (isSqlTaggedTemplate(node.parent)) {
              reportNamedTimestampText(node, quasis, expressions);
            }

            // Statement text up to (and including) each interpolation's own
            // quasi, so the SET-vs-WHERE clause of an `=` can be decided.
            let precedingSql = "";
            for (const [index, expression] of expressions.entries()) {
              precedingSql += stripSqlComments(rawTextOf(quasis[index]));

              if (
                isTimestampTextComparison(
                  quasis,
                  expressions,
                  index,
                  precedingSql,
                )
              ) {
                context.report({
                  node: expression,
                  messageId: "timestampTextComparison",
                });
                continue;
              }

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
            const args = Array.isArray(node.arguments) ? node.arguments : [];
            if (reportRawStatement(node, args)) {
              return;
            }
            // `inArray(timestampCasToken(t.updatedAt), tokens)` compares the
            // same text, once per listed token.
            if (callee !== undefined && DRIZZLE_LIST_COMPARISONS.has(callee)) {
              const [listed] = args;
              if (isTimestampTextOperand(listed, textMatchers)) {
                context.report({
                  node: listed,
                  messageId: "timestampTextComparison",
                });
              }
              return;
            }
            if (callee === undefined || !DRIZZLE_COMPARISONS.has(callee)) {
              return;
            }
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

            for (const side of [left, right]) {
              if (isTimestampTextOperand(side, textMatchers)) {
                context.report({
                  node: side,
                  messageId: "timestampTextComparison",
                });
                return;
              }
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
