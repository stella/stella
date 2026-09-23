// Passive regression fixture for `require-escape-like/require-escape-like`.
//
// Each `oxlint-disable-next-line` below marks a case the rule MUST flag; each
// `expect-clean` marks a case it must accept.

import {
  ilike,
  like as likeOperator,
  notIlike,
  sql,
  type SQL,
} from "drizzle-orm";
import * as ops from "drizzle-orm";

import { escapeLike } from "@/api/lib/escape-like";

declare const column: SQL;
declare const q: string;
declare const fold: (value: string) => SQL;

// Inline un-escaped interpolation.
export const inlineUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  ilike(column, `%${q}%`);

// A const pattern resolved to an un-escaped template literal.
const unsafePattern = `%${q}%`;
export const constUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  likeOperator(column, unsafePattern);

// An un-escaped prefix interpolation.
export const prefixUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  notIlike(column, `${q}%`);

// Namespace member call.
export const namespaceMember = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  ops.ilike(column, `%${q}%`);

// Destructured from the namespace.
const { notLike } = ops;
export const destructured = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  notLike(column, `%${q}`);

// Sequence-expression callee.
export const sequenceCallee = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  (0, ilike)(column, `%${q}%`);

// String concatenation pattern.
export const concatenated = () =>
  // oxlint-disable-next-line prefer-template, require-escape-like/require-escape-like -- fixture: concatenated pattern
  ilike(column, "%" + q + "%");

// `sql` template: interpolated operand of ILIKE.
export const sqlOperand = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  sql`${column} ILIKE ${`%${q}%`}`;

// `sql` template: NOT LIKE in lower case.
export const sqlNotLike = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  sql`${column} not like ${`${q}%`}`;

// `sql` template: value concatenated into the pattern in SQL.
export const sqlConcat = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  sql`${column} LIKE '%' || ${q} || '%'`;

// `sql` template: operand followed by an SQL concatenation.
export const sqlConcatAfter = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  sql`${column} LIKE ${fold(q)} || '%'`;

// A same-named local helper is not the shared escape helper.
export const localHelper = () => {
  // oxlint-disable-next-line no-shadow -- fixture: same-named local helper
  const escapeLike = (value: string) => value;
  // oxlint-disable-next-line require-escape-like/require-escape-like
  return ilike(column, `%${escapeLike(q)}%`);
};

// Every interpolation wrapped in escapeLike.
export const escapedInline = () =>
  // expect-clean: require-escape-like/require-escape-like
  ilike(column, `%${escapeLike(q)}%`);

export const escapedPrefix = () =>
  // expect-clean: require-escape-like/require-escape-like
  likeOperator(column, `${escapeLike(q)}%`);

// Escaped concatenation.
export const escapedConcat = () =>
  // expect-clean: require-escape-like/require-escape-like
  ilike(column, "%" + escapeLike(q) + "%"); // oxlint-disable-line prefer-template -- fixture: concatenated pattern

// Escaped value held in a const.
const safeValue = escapeLike(q);
export const escapedConst = () =>
  // expect-clean: require-escape-like/require-escape-like
  ops.ilike(column, `%${safeValue}%`);

// Escaped `sql` operand and escaped SQL concatenation through a wrapper.
export const escapedSqlOperand = () =>
  // expect-clean: require-escape-like/require-escape-like
  sql`${column} ILIKE ${`%${escapeLike(q)}%`}`;

export const escapedSqlConcat = () =>
  // expect-clean: require-escape-like/require-escape-like
  sql`${column} LIKE '%' || ${fold(escapeLike(q))} || '%'`;

// Non-LIKE comparison in a `sql` template.
export const sqlEquality = () =>
  // expect-clean: require-escape-like/require-escape-like
  sql`${column} = ${`%${q}%`}`;

// Constant pattern with no interpolation.
export const literalPattern = () =>
  // expect-clean: require-escape-like/require-escape-like
  ilike(column, "literal");

// Opaque variable the rule cannot inspect.
declare const opaquePattern: string;
export const opaque = () =>
  // expect-clean: require-escape-like/require-escape-like
  ilike(column, opaquePattern);

// A local function named like the operator is not drizzle's.
export const localOperator = () => {
  const ilikeLocal = (_column: SQL, pattern: string) => pattern;
  // expect-clean: require-escape-like/require-escape-like
  return ilikeLocal(column, `%${q}%`);
};
