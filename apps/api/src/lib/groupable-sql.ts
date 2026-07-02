import { panic } from "better-result";
import {
  Column,
  is,
  Name,
  Placeholder,
  Param,
  SQL,
  StringChunk,
  Table,
  View,
} from "drizzle-orm";
import type { SQLChunk } from "drizzle-orm";

/**
 * Wrap a drizzle `sql` fragment that is rendered into BOTH a SELECT
 * expression and a GROUP BY / ORDER BY clause, asserting it carries no
 * bind parameters.
 *
 * Why this exists: Postgres identifies a grouped SELECT expression by its
 * rendered text, and drizzle numbers bind placeholders per render — the
 * SELECT copy of a fragment gets `$1`, the GROUP BY copy gets `$3`. A
 * fragment with a single bound value therefore renders differently in the
 * two positions, and Postgres rejects the query at runtime with
 * "column ... must appear in the GROUP BY clause". The type system cannot
 * see this: both renderings share one TypeScript type.
 *
 * `groupableSql` makes that mismatch impossible to construct. It walks the
 * fragment's chunk tree and `panic()`s if any chunk would render as a bound
 * placeholder. Only raw SQL text (`StringChunk`, i.e. `sql.raw(...)` and the
 * template's static parts) and schema identifiers (`Column`, `Table`,
 * `View`, `Name`) are allowed; nested `SQL` fragments are validated
 * recursively. Bare interpolated primitives, `sql.param(...)`,
 * `sql.placeholder(...)`, and any other value chunk are rejected.
 *
 * Fragments are module-level (or per-request) constants, so a bound value
 * fails at construction — module load for the common case — and any test or
 * boot catches it immediately rather than deferring to a live query.
 *
 * Genuinely dynamic values belong outside grouped fragments (e.g. bound in a
 * WHERE clause). Code constants that must appear inside a grouped fragment
 * are inlined byte-identically with `sql.raw(...)`.
 */
export const groupableSql = <T>(fragment: SQL<T>): SQL<T> => {
  const boundChunk = findBoundChunk(fragment.queryChunks);
  if (boundChunk !== undefined) {
    panic(
      `groupableSql: fragment "${sketchChunks(fragment.queryChunks)}" contains a bound parameter (${boundChunk}). ` +
        "A fragment rendered into both a SELECT list and a GROUP BY/ORDER BY clause must carry no bind " +
        "parameters: Postgres numbers placeholders per render, so the two copies would diverge and the query " +
        "would fail at runtime. Inline code constants with sql.raw(...) instead.",
    );
  }

  return fragment;
};

// Returns a human-readable description of the first chunk that would render as
// a bound placeholder, or `undefined` when every chunk is safe. Walks nested
// SQL fragments and chunk arrays so a bound value at any depth is caught.
const findBoundChunk = (chunks: readonly SQLChunk[]): string | undefined => {
  for (const chunk of chunks) {
    const bound = describeBoundChunk(chunk);
    if (bound !== undefined) {
      return bound;
    }
  }

  return undefined;
};

const describeBoundChunk = (chunk: SQLChunk): string | undefined => {
  if (chunk === undefined || isSafeIdentifierChunk(chunk)) {
    return undefined;
  }
  if (is(chunk, SQL)) {
    return findBoundChunk(chunk.queryChunks);
  }
  if (Array.isArray(chunk)) {
    return findBoundChunk(chunk);
  }
  if (is(chunk, Param)) {
    return "bound Param";
  }
  if (is(chunk, Placeholder)) {
    return "placeholder";
  }

  // A bare interpolated primitive (`sql`... ${value}``) is not a drizzle
  // entity: drizzle binds it as a driver parameter, so it renders as `$n`
  // just like an explicit Param.
  return `bound ${typeof chunk} value`;
};

const isSafeIdentifierChunk = (chunk: SQLChunk): boolean =>
  is(chunk, StringChunk) ||
  is(chunk, Column) ||
  is(chunk, Table) ||
  is(chunk, View) ||
  is(chunk, Name);

// Renders a readable outline of a fragment for panic messages: raw text is
// shown verbatim, identifiers and bound values as placeholders. Never used for
// SQL generation, so it need not be executable.
const sketchChunks = (chunks: readonly SQLChunk[]): string =>
  chunks.map(sketchChunk).join("");

const sketchChunk = (chunk: SQLChunk): string => {
  if (chunk === undefined) {
    return "";
  }
  if (is(chunk, StringChunk)) {
    return chunk.value.join("");
  }
  if (is(chunk, SQL)) {
    return sketchChunks(chunk.queryChunks);
  }
  if (Array.isArray(chunk)) {
    return sketchChunks(chunk);
  }
  if (isSafeIdentifierChunk(chunk)) {
    return "⟨identifier⟩";
  }
  return "⟨bound⟩";
};
