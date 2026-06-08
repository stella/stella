/**
 * Arithmetic evaluator for computed template fields.
 *
 * The condition engine ([[evaluateCondition]]) is boolean-only by design.
 * Computed fields need a value, so this is a separate, pure recursive-descent
 * evaluator: `+ - * / %`, unary `-`, parentheses, numeric literals (with `_`
 * separators and decimals), dotted-path variables resolved from the fill data,
 * and the functions `min`, `max`, `round` (optional 2nd arg = decimal places),
 * `abs`, `floor`, `ceil`.
 *
 * Example — rent indexed by CPI but capped at +5%/yr:
 *   `min(rent * (1 + index / 100), rent * 1.05)`
 *
 * Returns `undefined` on any parse or resolution failure (bad syntax, a
 * non-numeric variable, division producing a non-finite result) so callers
 * can fall back to leaving the field unfilled rather than emitting `NaN`.
 */

import { resolvePath } from "./index.js";

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "%" }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

const TOKEN_RE =
  /([0-9][0-9_]*(?:\.[0-9]+)?)|([\p{L}_][\p{L}\p{N}_.]*)|([+\-*/%(),])|(\S)/gu;

const PRECEDENCE: Record<string, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "%": 2,
};

const tokenize = (expression: string): Tok[] => {
  const tokens: Tok[] = [];
  for (const match of expression.matchAll(TOKEN_RE)) {
    const [, numeric, ident, punct, invalid] = match;
    if (invalid !== undefined) {
      throw new Error(`Unexpected token: ${invalid}`);
    }
    if (numeric !== undefined) {
      tokens.push({ t: "num", v: Number(numeric.replace(/_/gu, "")) });
    } else if (ident !== undefined) {
      tokens.push({ t: "id", v: ident });
    } else if (punct === "(") {
      tokens.push({ t: "lp" });
    } else if (punct === ")") {
      tokens.push({ t: "rp" });
    } else if (punct === ",") {
      tokens.push({ t: "comma" });
    } else if (punct !== undefined) {
      // SAFETY: the punct group only matches one of + - * / %.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tokens.push({ t: "op", v: punct as "+" | "-" | "*" | "/" | "%" });
    }
  }
  return tokens;
};

const applyOp = (op: string, a: number, b: number): number => {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    default:
      return a % b;
  }
};

const callFunction = (name: string, args: readonly number[]): number => {
  switch (name) {
    case "min":
      return Math.min(...args);
    case "max":
      return Math.max(...args);
    case "abs":
      return Math.abs(args[0] ?? Number.NaN);
    case "floor":
      return Math.floor(args[0] ?? Number.NaN);
    case "ceil":
      return Math.ceil(args[0] ?? Number.NaN);
    case "round": {
      const value = args[0] ?? Number.NaN;
      const digits = args[1] ?? 0;
      const factor = 10 ** Math.trunc(digits);
      return Math.round(value * factor) / factor;
    }
    default:
      throw new Error(`Unknown function: ${name}`);
  }
};

export const evaluateNumericExpression = (
  expression: string,
  data: Record<string, unknown>,
): number | undefined => {
  // Recursive-descent parse; internal throws are caught at this boundary and
  // converted to `undefined` (an unparseable / non-numeric expression is not
  // a value, not an exception the caller should handle).
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) {
      return undefined;
    }

    let pos = 0;

    const resolveIdentifier = (path: string): number => {
      const raw = resolvePath(path, data);
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        throw new Error(`Non-numeric variable: ${path}`);
      }
      return num;
    };

    // Defined before parseBinary; only *called* at runtime (after both exist),
    // so the forward reference inside the body is safe.
    const parseAtom = (): number => {
      const tok = tokens[pos];
      if (!tok) {
        throw new Error("Unexpected end of expression");
      }

      if (tok.t === "op" && (tok.v === "-" || tok.v === "+")) {
        pos += 1;
        const operand = parseAtom();
        return tok.v === "-" ? -operand : operand;
      }

      if (tok.t === "num") {
        pos += 1;
        return tok.v;
      }

      if (tok.t === "lp") {
        pos += 1;
        // oxlint-disable-next-line no-use-before-define -- runtime-only forward ref
        const value = parseBinary(0);
        if (tokens[pos]?.t !== "rp") {
          throw new Error("Expected )");
        }
        pos += 1;
        return value;
      }

      if (tok.t === "id") {
        pos += 1;
        if (tokens[pos]?.t === "lp") {
          pos += 1;
          const args: number[] = [];
          if (tokens[pos]?.t !== "rp") {
            // oxlint-disable-next-line no-use-before-define -- runtime-only forward ref
            args.push(parseBinary(0));
            while (tokens[pos]?.t === "comma") {
              pos += 1;
              // oxlint-disable-next-line no-use-before-define -- runtime-only forward ref
              args.push(parseBinary(0));
            }
          }
          if (tokens[pos]?.t !== "rp") {
            throw new Error("Expected )");
          }
          pos += 1;
          return callFunction(tok.v, args);
        }
        return resolveIdentifier(tok.v);
      }

      throw new Error("Unexpected token in expression");
    };

    const parseBinary = (minPrecedence: number): number => {
      let left = parseAtom();
      let next = tokens[pos];
      while (next?.t === "op" && (PRECEDENCE[next.v] ?? 0) >= minPrecedence) {
        const op = next.v;
        pos += 1;
        const right = parseBinary((PRECEDENCE[op] ?? 0) + 1);
        left = applyOp(op, left, right);
        next = tokens[pos];
      }
      return left;
    };

    const result = parseBinary(0);
    if (pos !== tokens.length) {
      return undefined; // trailing tokens — malformed
    }
    return Number.isFinite(result) ? result : undefined;
  } catch {
    return undefined;
  }
};
