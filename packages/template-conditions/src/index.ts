/**
 * Shared condition evaluation for DOCX template
 * conditionals. Pure functions with no runtime dependencies;
 * usable on both backend (Bun) and frontend (browser).
 */

// ── Types ─────────────────────────────────────────────────

export type NamedCondition = {
  name: string;
  expression: string;
  label?: string;
};

// ── Path resolution ───────────────────────────────────────

/** Narrow `unknown` to a string-keyed record. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Resolve a dotted path like `company.name` against data. */
export const resolvePath = (
  path: string,
  data: Record<string, unknown>,
): unknown => {
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (!isRecord(current)) {
      return;
    }
    current = current[part];
  }
  return current;
};

// ── Tokenizer ─────────────────────────────────────────────

type Token =
  | { type: "value"; raw: string }
  | { type: "op"; raw: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "string"; raw: string };

const TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|==|!=|>=|<=|>|<|!(?!=)|and\b|or\b|[()]|[\p{L}\p{N}_.]+)/gu;

const STARTS_WITH_DIGIT_RE = /^\d/;

const tokenize = (expr: string): Token[] => {
  const tokens: Token[] = [];
  for (const m of expr.matchAll(TOKEN_RE)) {
    const raw = m[1] ?? m[0];
    if (raw === "and") {
      tokens.push({ type: "and" });
    } else if (raw === "or") {
      tokens.push({ type: "or" });
    } else if (raw === "!") {
      tokens.push({ type: "not" });
    } else if (
      raw === "==" ||
      raw === "!=" ||
      raw === ">" ||
      raw === "<" ||
      raw === ">=" ||
      raw === "<="
    ) {
      tokens.push({ type: "op", raw });
    } else if (raw === "(") {
      tokens.push({ type: "lparen" });
    } else if (raw === ")") {
      tokens.push({ type: "rparen" });
    } else if (raw.startsWith('"')) {
      tokens.push({
        type: "string",
        raw: raw.slice(1, -1).replace(/\\"/g, '"'),
      });
    } else {
      tokens.push({ type: "value", raw });
    }
  }
  return tokens;
};

// ── Helpers ───────────────────────────────────────────────

/** Parse a numeric literal, supporting `_` separators. */
const parseNumeric = (raw: string): number | undefined => {
  if (!STARTS_WITH_DIGIT_RE.test(raw)) {
    return;
  }
  const cleaned = raw.replace(/_/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Resolve a token to a concrete value in the data context.
 * String literals return as strings; identifiers resolve via
 * dotted path; numeric-looking values parse as numbers.
 */
const resolveToken = (
  token: Token,
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
  _resolved?: Set<string>,
): unknown => {
  if (token.type === "string") {
    return token.raw;
  }
  if (token.type === "value") {
    const num = parseNumeric(token.raw);
    if (num !== undefined) {
      return num;
    }
    if (token.raw === "true") {
      return true;
    }
    if (token.raw === "false") {
      return false;
    }
    if (namedConditions) {
      const named = namedConditions.find((c) => c.name === token.raw);
      if (named) {
        const resolved = new Set(_resolved);
        if (resolved.has(token.raw)) {
          return false;
        }
        resolved.add(token.raw);
        return evaluateCondition(
          named.expression,
          data,
          namedConditions,
          resolved,
        );
      }
    }
    return resolvePath(token.raw, data);
  }
  return;
};

/** Evaluate a comparison between two resolved values. */
const compare = (left: unknown, op: string, right: unknown): boolean => {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return (
        typeof left === "number" && typeof right === "number" && left > right
      );
    case "<":
      return (
        typeof left === "number" && typeof right === "number" && left < right
      );
    case ">=":
      return (
        typeof left === "number" && typeof right === "number" && left >= right
      );
    case "<=":
      return (
        typeof left === "number" && typeof right === "number" && left <= right
      );
    default:
      return false;
  }
};

/**
 * Test truthiness: non-empty string, non-zero, true,
 * non-empty array.
 */
const isTruthy = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return true;
  }
  return false;
};

// ── Token-level evaluator (supports parentheses) ─────────

type Atom = { negated: boolean; value: boolean };

/**
 * Find the matching closing parenthesis for an opening
 * paren at `start`. Returns the index of the `)` token.
 */
const findMatchingParen = (tokens: Token[], start: number): number => {
  let depth = 1;
  for (let j = start + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (!tok) {
      break;
    }
    if (tok.type === "lparen") {
      depth++;
    } else if (tok.type === "rparen") {
      depth--;
      if (depth === 0) {
        return j;
      }
    }
  }
  return tokens.length; // unmatched — treat as end
};

/**
 * Evaluate a token stream with full operator precedence:
 * `!` > comparisons > `and` > `or`. Supports `(...)` for
 * explicit grouping.
 */
const evaluateTokens = (
  tokens: Token[],
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
  _resolved?: Set<string>,
): boolean => {
  const atoms: Atom[] = [];
  const connectors: ("and" | "or")[] = [];

  /** Get token at index; returns undefined past end. */
  const at = (idx: number): Token | undefined => tokens[idx];

  let i = 0;
  while (i < tokens.length) {
    const current = at(i);
    if (!current) {
      break;
    }

    // Skip closing parens (handled by recursion)
    if (current.type === "rparen") {
      i++;
      continue;
    }

    // Eat negation prefix
    let negated = false;
    while (at(i)?.type === "not") {
      negated = !negated;
      i++;
    }

    const tok = at(i);
    if (!tok) {
      atoms.push({ negated: false, value: false });
      break;
    }

    // Parenthesized sub-expression
    if (tok.type === "lparen") {
      const closeIdx = findMatchingParen(tokens, i);
      const inner = tokens.slice(i + 1, closeIdx);
      const value = evaluateTokens(inner, data, namedConditions, _resolved);
      atoms.push({ negated, value });
      i = closeIdx + 1;
    } else {
      // Regular atom: value, possibly followed by comparison
      const left = tok;
      i++;

      const maybeOp = at(i);
      if (maybeOp?.type === "op") {
        const op = maybeOp.raw;
        i++;
        const right = at(i);
        if (right) {
          i++;
          const lv = resolveToken(left, data, namedConditions, _resolved);
          const rv = resolveToken(right, data, namedConditions, _resolved);
          atoms.push({
            negated,
            value: compare(lv, op, rv),
          });
        } else {
          atoms.push({ negated, value: false });
        }
      } else {
        const resolved = resolveToken(left, data, namedConditions, _resolved);
        atoms.push({
          negated,
          value: isTruthy(resolved),
        });
      }
    }

    // Check for and/or connector
    const connector = at(i);
    if (connector?.type === "and") {
      connectors.push("and");
      i++;
    } else if (connector?.type === "or") {
      connectors.push("or");
      i++;
    }
  }

  const booleans = atoms.map((a) => (a.negated ? !a.value : a.value));

  // Apply `and` first (higher precedence), then `or`
  const orGroups: boolean[][] = [[]];
  let currentGroup = orGroups[0] ?? [];
  for (let j = 0; j < booleans.length; j++) {
    const bool = booleans[j];
    if (bool === undefined) {
      continue;
    }
    currentGroup.push(bool);
    if (j < connectors.length && connectors[j] === "or") {
      const next: boolean[] = [];
      orGroups.push(next);
      currentGroup = next;
    }
  }

  return orGroups.some((group) => group.every(Boolean));
};

// ── Main evaluator ────────────────────────────────────────

/**
 * Evaluate a Liquid-style condition expression.
 *
 * Supports truthiness, negation (`!`), comparisons
 * (`==`, `!=`, `>`, `<`, `>=`, `<=`), logical operators
 * (`and`, `or`), dotted paths, and numeric underscores.
 *
 * Operator precedence (highest to lowest):
 * 1. `!` (negation)
 * 2. Comparisons
 * 3. `and`
 * 4. `or`
 *
 * Supports `(...)` for explicit grouping. No arithmetic.
 */
export const evaluateCondition = (
  expression: string,
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
  _resolved?: Set<string>,
): boolean => {
  if (namedConditions) {
    const trimmed = expression.trim();
    const named = namedConditions.find((c) => c.name === trimmed);
    if (named) {
      const resolved = new Set(_resolved);
      if (resolved.has(trimmed)) {
        return false;
      }
      resolved.add(trimmed);
      return evaluateCondition(
        named.expression,
        data,
        namedConditions,
        resolved,
      );
    }
  }

  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    return false;
  }

  return evaluateTokens(tokens, data, namedConditions, _resolved);
};
