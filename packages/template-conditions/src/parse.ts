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

const TOKEN_RE =
  /(?<token>"[^"\\]*(?:\\.[^"\\]*)*"|==|!=|>=|<=|>|<|!(?!=)|and\b|or\b|contains\b|[()]|-?\d[\p{N}_.]*|[\p{L}\p{N}_.]+(?:-[\p{L}\p{N}_.]+)*)/gu;

const STARTS_WITH_DIGIT_RE = /^-?\d/u;

const COMPARE_SYMBOL_TO_OP: Record<string, CompareOp> = {
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
};

const tokenize = (expr: string): Token[] => {
  const tokens: Token[] = [];
  for (const m of expr.matchAll(TOKEN_RE)) {
    const raw = m.groups?.["token"] ?? m[0];
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
      raw === "<=" ||
      raw === "contains"
    ) {
      tokens.push({ type: "op", raw });
    } else if (raw === "(") {
      tokens.push({ type: "lparen" });
    } else if (raw === ")") {
      tokens.push({ type: "rparen" });
    } else if (raw.startsWith('"')) {
      tokens.push({
        type: "string",
        raw: raw.slice(1, -1).replace(/\\"/gu, '"'),
      });
    } else {
      tokens.push({ type: "value", raw });
    }
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
