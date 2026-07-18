/**
 * Parse a template `{{#if ...}}` condition expression into the canonical
 * `@stll/conditions` AST. The surface syntax — `==`, `!=`, `>`, `<`, `>=`,
 * `<=`, `contains`, `and`, `or`, `!`, parentheses, dotted-path identifiers,
 * and string / number / boolean literals — maps onto `CompareNode` /
 * `PredicateNode` / `GroupNode` with `path` and `literal` operands. Operator
 * semantics and evaluation live in `@stll/conditions`; this module is purely
 * surface-syntax → AST.
 *
 * A bare identifier becomes a `path` operand. Whether that path names a
 * reusable condition or a fill-bag value is decided at evaluation time by the
 * resolver, so named-condition references are NOT expanded here.
 *
 * Precedence (lowest to highest): `or` < `and` < `!` < comparison. `(...)`
 * groups explicitly. Malformed input degrades gracefully (an unmatched `(`
 * closes at end of input; trailing tokens are ignored) rather than throwing,
 * so a half-typed condition never breaks a fill.
 */
import type { CompareOp, ConditionNode, Operand } from "@stll/conditions";

type Token =
  | { type: "value"; raw: string }
  | { type: "op"; raw: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "string"; raw: string };

// Every alternative below is a bounded, single-outcome match: once the first
// character commits to a branch, that branch cannot fail partway through and
// backtrack into a different split of the input. The quoted-string literal
// used to be a branch of this same regex (`"[^"\\]*(?:\\.[^"\\]*)*"`), but a
// closing quote is not guaranteed to exist, so an unterminated string forces
// the (unanchored) `matchAll` scan below to retry an expensive "find the
// close, honoring escapes" search starting at every subsequent `"` in the
// input — quadratic on adversarial input. `scanString` below handles quoted
// strings with a dedicated, guaranteed-single-pass scan instead, so this
// regex only ever needs to match (or fail to match, in O(1)) at the exact
// position it is asked to start from.
const NON_STRING_TOKEN_RE =
  /(?<token>==|!=|>=|<=|>|<|!(?!=)|and\b|or\b|contains\b|[()]|-?\d[\p{N}_.]*|[\p{L}\p{N}_.]+(?:-[\p{L}\p{N}_.]+)*)/uy;

const STARTS_WITH_DIGIT_RE = /^-?\d/u;

const COMPARE_SYMBOL_TO_OP: Record<string, CompareOp> = {
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
};

type StringScan = { content: string; end: number };

/**
 * Scan a `"..."` literal starting at `expr[start]` (the opening quote),
 * honoring `\\`-escapes without interpreting them. A single linear pass:
 * each character is visited at most once, so this is safe on adversarial
 * input regardless of how many `"` or `\\` characters it contains.
 *
 * A closing quote is not required — consistent with the module's
 * degrade-gracefully policy for an unmatched `(`, a literal missing its
 * closing quote simply closes at end of input.
 */
const scanString = (expr: string, start: number): StringScan => {
  let i = start + 1;
  while (i < expr.length) {
    if (expr[i] === '"') {
      return { content: expr.slice(start + 1, i), end: i + 1 };
    }
    i += expr[i] === "\\" && i + 1 < expr.length ? 2 : 1;
  }
  return { content: expr.slice(start + 1), end: expr.length };
};

const classifyNonString = (raw: string): Token => {
  if (raw === "and") {
    return { type: "and" };
  }
  if (raw === "or") {
    return { type: "or" };
  }
  if (raw === "!") {
    return { type: "not" };
  }
  if (
    raw === "==" ||
    raw === "!=" ||
    raw === ">" ||
    raw === "<" ||
    raw === ">=" ||
    raw === "<=" ||
    raw === "contains"
  ) {
    return { type: "op", raw };
  }
  if (raw === "(") {
    return { type: "lparen" };
  }
  if (raw === ")") {
    return { type: "rparen" };
  }
  return { type: "value", raw };
};

const tokenize = (expr: string): Token[] => {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expr.length) {
    if (expr[pos] === '"') {
      const { content, end } = scanString(expr, pos);
      tokens.push({ type: "string", raw: content.replace(/\\"/gu, '"') });
      pos = end;
      continue;
    }
    NON_STRING_TOKEN_RE.lastIndex = pos;
    const m = NON_STRING_TOKEN_RE.exec(expr);
    if (!m) {
      // Unrecognized character (e.g. stray whitespace): skip it, same as an
      // unanchored regex scan would.
      pos += 1;
      continue;
    }
    tokens.push(classifyNonString(m.groups?.["token"] ?? m[0]));
    pos = NON_STRING_TOKEN_RE.lastIndex;
  }
  return tokens;
};

/** Parse a numeric literal, supporting `_` separators. */
const parseNumeric = (raw: string): number | undefined => {
  if (!STARTS_WITH_DIGIT_RE.test(raw)) {
    return undefined;
  }
  const n = Number(raw.replace(/_/gu, ""));
  return Number.isFinite(n) ? n : undefined;
};

/** A `value`/`string` token becomes a literal (string / number / boolean) or a
 *  dotted `path` operand. */
const operandFromToken = (
  token: Token & { type: "value" | "string" },
): Operand => {
  if (token.type === "string") {
    return { type: "literal", value: token.raw };
  }
  const num = parseNumeric(token.raw);
  if (num !== undefined) {
    return { type: "literal", value: num };
  }
  if (token.raw === "true") {
    return { type: "literal", value: true };
  }
  if (token.raw === "false") {
    return { type: "literal", value: false };
  }
  return { type: "path", path: token.raw };
};

/** `contains` carries a literal payload (`string`), not an operand: render the
 *  right-hand token as a string. */
const containsValue = (token: Token & { type: "value" | "string" }): string => {
  const operand = operandFromToken(token);
  return operand.type === "literal" ? String(operand.value) : token.raw;
};

export const parseCondition = (expression: string): ConditionNode | null => {
  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    return null;
  }

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  // or := and ( "or" and )*
  const parseOr = (): ConditionNode => {
    const first = parseAnd();
    if (peek()?.type !== "or") {
      return first;
    }
    const children = [first];
    while (peek()?.type === "or") {
      pos += 1;
      children.push(parseAnd());
    }
    return { type: "group", combinator: "or", children };
  };

  // and := not ( "and" not )*
  const parseAnd = (): ConditionNode => {
    const first = parseNot();
    if (peek()?.type !== "and") {
      return first;
    }
    const children = [first];
    while (peek()?.type === "and") {
      pos += 1;
      children.push(parseNot());
    }
    return { type: "group", combinator: "and", children };
  };

  // not := "!" not | comparison
  const parseNot = (): ConditionNode => {
    if (peek()?.type === "not") {
      pos += 1;
      return {
        type: "group",
        combinator: "and",
        negated: true,
        children: [parseNot()],
      };
    }
    return parseComparison();
  };

  // comparison := "(" or ")" | operand ( compareOp operand )?
  const parseComparison = (): ConditionNode => {
    if (peek()?.type === "lparen") {
      pos += 1;
      const inner = parseOr();
      if (peek()?.type === "rparen") {
        pos += 1;
      }
      return inner;
    }

    const leftTok = peek();
    if (!leftTok || (leftTok.type !== "value" && leftTok.type !== "string")) {
      // Stray operator / closing paren: contributes nothing.
      pos += 1;
      return { type: "group", combinator: "and", children: [] };
    }
    pos += 1;
    const left = operandFromToken(leftTok);

    const opTok = peek();
    if (opTok?.type !== "op") {
      // Bare value → truthiness test.
      return { type: "predicate", operand: left, op: "is_truthy" };
    }
    pos += 1;

    const rightTok = peek();
    if (
      !rightTok ||
      (rightTok.type !== "value" && rightTok.type !== "string")
    ) {
      // Dangling operator: fall back to the bare truthiness of the left operand.
      return { type: "predicate", operand: left, op: "is_truthy" };
    }
    pos += 1;

    if (opTok.raw === "contains") {
      return {
        type: "predicate",
        operand: left,
        op: "contains",
        value: containsValue(rightTok),
      };
    }
    return {
      type: "compare",
      left,
      op: COMPARE_SYMBOL_TO_OP[opTok.raw] ?? "eq",
      right: operandFromToken(rightTok),
    };
  };

  return parseOr();
};
