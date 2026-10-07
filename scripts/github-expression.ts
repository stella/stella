/**
 * Three-valued evaluation of GitHub Actions `if:` expressions.
 *
 * Context values a caller does not pin are UNKNOWN, and every operator follows
 * Kleene logic: `UNKNOWN && false` is false, `UNKNOWN || false` stays UNKNOWN.
 * A condition that evaluates to a definite false therefore cannot run under any
 * value of the unpinned context, which is what workflow guards need to prove
 * ("this job never runs for a run from another repository").
 *
 * Covers the expression grammar workflows use: literals, context paths,
 * `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, parentheses and the
 * built-in functions. Anything else panics, so a guard fails loudly instead of
 * guessing.
 */

import { panic } from "better-result";

export const UNKNOWN = Symbol("unknown");
type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
export type Result = Value | typeof UNKNOWN;

type Token =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "word"; value: string }
  | { kind: "op"; value: string };

const OPERATORS = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "!",
  "<",
  ">",
  "(",
  ")",
  ",",
];
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

const operatorAt = (source: string, index: number) =>
  OPERATORS.find((op) => source.startsWith(op, index));

/** Reads a quoted string starting at `start` (the opening quote). */
const readString = (
  source: string,
  start: number,
): { value: string; end: number } => {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "'" && source[index + 1] === "'") {
      value += "'";
      index += 2;
    } else if (source[index] === "'") {
      return { value, end: index + 1 };
    } else {
      value += source[index];
      index += 1;
    }
  }
  return panic(`unterminated string in: ${source}`);
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/u.exec(rest);
    const operator = operatorAt(source, index);
    const number = /^-?\d+(\.\d+)?/u.exec(rest);
    const word = /^[A-Za-z_][\w-]*(\.[\w-]+|\[\*\]|\.\*)*/u.exec(rest);
    if (space) {
      index += space[0].length;
    } else if (source[index] === "'") {
      const { value, end } = readString(source, index);
      tokens.push({ kind: "string", value });
      index = end;
    } else if (operator !== undefined) {
      tokens.push({ kind: "op", value: operator });
      index += operator.length;
    } else if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      index += number[0].length;
    } else if (word) {
      tokens.push({ kind: "word", value: word[0] });
      index += word[0].length;
    } else {
      panic(`unexpected '${source[index] ?? ""}' in: ${source}`);
    }
  }
  return tokens;
};

const isTruthy = (value: Result): boolean | typeof UNKNOWN => {
  if (value === UNKNOWN) {
    return UNKNOWN;
  }
  return !(value === false || value === null || value === 0 || value === "");
};

const text = (value: Value | undefined): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === null || value === undefined ? "" : JSON.stringify(value);
};

const looseEquals = (left: Value | undefined, right: Value | undefined) =>
  typeof left === "string" && typeof right === "string"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

const compare = (operator: string, left: Result, right: Result): Result => {
  if (left === UNKNOWN || right === UNKNOWN) {
    return UNKNOWN;
  }
  if (operator === "==") {
    return looseEquals(left, right);
  }
  if (operator === "!=") {
    return !looseEquals(left, right);
  }
  const a = Number(left);
  const b = Number(right);
  if (operator === "<") {
    return a < b;
  }
  if (operator === "<=") {
    return a <= b;
  }
  if (operator === ">") {
    return a > b;
  }
  return a >= b;
};

const toValue = (parsed: unknown): Value => {
  if (
    parsed === null ||
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean"
  ) {
    return parsed;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item: unknown) => toValue(item));
  }
  if (typeof parsed === "object") {
    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]: [string, unknown]) => [
        key,
        toValue(item),
      ]),
    );
  }
  return panic(`fromJSON produced an unsupported value: ${typeof parsed}`);
};

export type Context = {
  /** Values for context paths; a path not listed is UNKNOWN. */
  values: Record<string, Value>;
  /** Value for a path not in `values` (e.g. every output of a skipped job). */
  fallback?: (path: string) => Value | undefined;
  /** Results of status functions; one not listed is UNKNOWN. */
  status?: Partial<
    Record<"always" | "success" | "failure" | "cancelled", boolean>
  >;
};

const nestedValue = (
  value: Value | undefined,
  parts: readonly string[],
): Value | undefined => {
  const key = parts.at(0);
  if (key === undefined) {
    return value;
  }
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const rest = parts.slice(1);
  if (key === "*") {
    const projected: Value[] = [];
    for (const item of Object.values(value)) {
      const result = nestedValue(item, rest);
      if (result !== undefined) {
        projected.push(result);
      }
    }
    return projected;
  }
  if (Array.isArray(value)) {
    return /^(0|[1-9][0-9]*)$/u.test(key)
      ? nestedValue(value.at(Number(key)), rest)
      : undefined;
  }
  return nestedValue(value[key], rest);
};

export const contextFromNested = (context: object): Context => {
  const values = new Map<string, Value>();
  const status = new Map<string, boolean>();
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== "function") {
      values.set(key, toValue(value));
      continue;
    }
    if (
      key !== "always" &&
      key !== "success" &&
      key !== "failure" &&
      key !== "cancelled"
    ) {
      continue;
    }
    const outcome: unknown = value();
    if (typeof outcome !== "boolean") {
      panic(`Invalid GitHub status function result: ${key}`);
    }
    status.set(key, outcome);
  }
  return {
    values: {},
    status: Object.fromEntries(status),
    fallback: (path) => {
      const [root, ...parts] = path.split(".");
      return root === undefined
        ? undefined
        : nestedValue(values.get(root), parts);
    },
  };
};

const STATUS_FUNCTIONS = new Set(["always", "success", "failure", "cancelled"]);

const callFunction = (
  name: string,
  args: Result[],
  context: Context,
): Result => {
  const lower = name.toLowerCase();
  if (STATUS_FUNCTIONS.has(lower)) {
    const status = context.status ?? {};
    const known = Object.entries(status).find(([key]) => key === lower)?.[1];
    return known ?? UNKNOWN;
  }
  const values = args.filter((arg): arg is Value => arg !== UNKNOWN);
  if (values.length !== args.length) {
    return UNKNOWN;
  }
  const [first, second] = values;
  switch (lower) {
    case "fromjson": {
      const parsed: unknown = JSON.parse(text(first));
      return toValue(parsed);
    }
    case "tojson":
      return JSON.stringify(first);
    case "contains":
      return Array.isArray(first)
        ? first.some((item) => looseEquals(item, second))
        : text(first).toLowerCase().includes(text(second).toLowerCase());
    case "startswith":
      return text(first).toLowerCase().startsWith(text(second).toLowerCase());
    case "endswith":
      return text(first).toLowerCase().endsWith(text(second).toLowerCase());
    default:
      // format, join, hashFiles and friends: no guard depends on their value.
      return UNKNOWN;
  }
};

const and3 = (left: Result, right: Result): Result => {
  const a = isTruthy(left);
  const b = isTruthy(right);
  if (a === false) {
    return left;
  }
  if (b === false) {
    return right;
  }
  return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : right;
};

const or3 = (left: Result, right: Result): Result => {
  const a = isTruthy(left);
  const b = isTruthy(right);
  if (a === true) {
    return left;
  }
  if (b === true) {
    return right;
  }
  return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : right;
};

/** Evaluates an `if:` condition (with or without `${{ }}`) in a partial context. */
export const evaluate = (source: string, context: Context): Result => {
  const trimmed = source.trim();
  const body = /^\$\{\{([\s\S]*)\}\}$/u.exec(trimmed)?.[1] ?? trimmed;
  const tokens = tokenize(body);
  let position = 0;
  const peek = () => tokens[position];
  const take = (value?: string): Token => {
    const token = tokens[position];
    if (token === undefined || (value !== undefined && token.value !== value)) {
      return panic(`expected ${value ?? "a token"} in: ${source}`);
    }
    position += 1;
    return token;
  };

  const lookup = (path: string): Result => {
    if (Object.hasOwn(context.values, path)) {
      return context.values[path] ?? null;
    }
    return context.fallback?.(path) ?? UNKNOWN;
  };

  const call = (name: string): Result => {
    take("(");
    const args: Result[] = [];
    while (peek()?.value !== ")") {
      args.push(or());
      if (peek()?.value === ",") {
        take(",");
      }
    }
    take(")");
    return callFunction(name, args, context);
  };

  const primary = (): Result => {
    const token = take();
    if (token.kind === "string" || token.kind === "number") {
      return token.value;
    }
    if (token.kind === "op" && token.value === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.kind === "op" && token.value === "!") {
      const truthy = isTruthy(primary());
      return truthy === UNKNOWN ? UNKNOWN : !truthy;
    }
    if (token.kind !== "word") {
      return panic(`unexpected '${token.value}' in: ${source}`);
    }
    if (token.value === "true" || token.value === "false") {
      return token.value === "true";
    }
    if (token.value === "null") {
      return null;
    }
    return peek()?.value === "(" ? call(token.value) : lookup(token.value);
  };

  const comparison = (): Result => {
    let left = primary();
    let next = peek();
    while (next?.kind === "op" && COMPARISONS.has(next.value)) {
      take();
      left = compare(next.value, left, primary());
      next = peek();
    }
    return left;
  };

  const and = (): Result => {
    let left = comparison();
    while (peek()?.value === "&&") {
      take("&&");
      left = and3(left, comparison());
    }
    return left;
  };

  const or = (): Result => {
    let left = and();
    while (peek()?.value === "||") {
      take("||");
      left = or3(left, and());
    }
    return left;
  };

  const value = or();
  if (position !== tokens.length) {
    return panic(`trailing tokens in: ${source}`);
  }
  return value;
};

/** True only when the condition is false whatever the unpinned context holds. */
export const definitelyFalse = (source: string, context: Context): boolean =>
  isTruthy(evaluate(source, context)) === false;

type ContextWithPlanOutputsOptions = {
  context: Context;
  outputs: Record<string, string>;
};

/** Resolve computed planner outputs from their source expressions, not fixture pins. */
export const contextWithPlanOutputs = ({
  context,
  outputs,
}: ContextWithPlanOutputsOptions): Context => {
  const projections = new Map<string, string>();
  const computed = new Map<string, string>();
  for (const [name, expression] of Object.entries(outputs)) {
    const output = `needs.ci-plan.outputs.${name}`;
    const reference =
      /^\$\{\{\s*([\w-]+(?:\.[\w-]+)+)(?:\s*\|\|\s*(?:'(?:[^']|'')*'|true|false|null|\d+))?\s*\}\}$/u.exec(
        expression,
      )?.[1];
    if (reference === undefined) {
      computed.set(output, expression);
    } else {
      projections.set(reference, output);
    }
  }
  const lookup = (path: string) =>
    Object.hasOwn(context.values, path)
      ? context.values[path]
      : context.fallback?.(path);
  const plannerContext = {
    ...context,
    fallback: (path: string) => {
      const direct = lookup(path);
      if (direct !== undefined) {
        return direct;
      }
      const projection = projections.get(path);
      return projection === undefined ? undefined : lookup(projection);
    },
  };
  return {
    ...context,
    values: Object.fromEntries(
      Object.entries(context.values).filter(([name]) => !computed.has(name)),
    ),
    fallback: (path) => {
      const expression = computed.get(path);
      if (expression === undefined) {
        return lookup(path);
      }
      const value = evaluate(expression, plannerContext);
      if (value === UNKNOWN) {
        return undefined;
      }
      if (value !== null && typeof value === "object") {
        panic(`Computed planner output is not scalar: ${path}`);
      }
      return value === null ? "" : String(value);
    },
  };
};
