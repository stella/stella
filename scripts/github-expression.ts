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

// The check pool evaluates step conditions before dependency installation
// may have succeeded; keep this module free of package imports.
class GitHubExpressionError extends Error {
  override name = "GitHubExpressionError";
  readonly _tag = "GitHubExpressionError";
}
const panic: (message: string) => never = (message) => {
  throw new GitHubExpressionError(message);
};

export const UNKNOWN = Symbol("unknown");
export type Value =
  string | number | boolean | null | Value[] | { [key: string]: Value };
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

// GitHub's number coercion for a comparison of two different types: null is 0,
// a boolean is 0 or 1, a string is a JSON number (blank reads as 0, anything
// else as NaN), and an array or object is NaN.
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const coercedNumber = (value: Value | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return 0;
    }
    return JSON_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
  }
  return Number.NaN;
};
const kind = (value: Value | undefined) => {
  if (value === null || value === undefined) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
};

// Loose equality as GitHub evaluates it: strings compare case-insensitively,
// arrays and objects only by identity, and values of different types as the
// numbers they coerce to. `null == ''` is therefore true, as it is for an
// unset job output in a workflow `if:`.
const looseEquals = (left: Value | undefined, right: Value | undefined) => {
  if (kind(left) !== kind(right)) {
    return coercedNumber(left) === coercedNumber(right);
  }
  return typeof left === "string" && typeof right === "string"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};

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

export const toValue = (parsed: unknown): Value => {
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
    case "format":
      return text(first).replaceAll(
        /\{\{|\}\}|\{(\d+)\}/gu,
        (token, index: string | undefined) => {
          if (index === undefined) {
            return token.slice(1);
          }
          const value = values[Number(index) + 1];
          return value === undefined
            ? panic(`format index ${index}`)
            : text(value);
        },
      );
    default:
      // join, hashFiles and friends: no guard depends on their value.
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

type ExpressionSemantics<T> = {
  literal: (value: Value) => T;
  reference: (path: string) => T;
  call: (name: string, args: T[]) => T;
  not: (value: T) => T;
  compare: (operator: string, left: T, right: T) => T;
  and: (left: T, right: T) => T;
  or: (left: T, right: T) => T;
};

const parseExpression = <T>(
  source: string,
  semantics: ExpressionSemantics<T>,
): T => {
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

  const call = (name: string): T => {
    take("(");
    const args: T[] = [];
    while (peek()?.value !== ")") {
      args.push(or());
      if (peek()?.value === ",") {
        take(",");
      }
    }
    take(")");
    return semantics.call(name, args);
  };

  const primary = (): T => {
    const token = take();
    if (token.kind === "string" || token.kind === "number") {
      return semantics.literal(token.value);
    }
    if (token.kind === "op" && token.value === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.kind === "op" && token.value === "!") {
      return semantics.not(primary());
    }
    if (token.kind !== "word") {
      return panic(`unexpected '${token.value}' in: ${source}`);
    }
    if (token.value === "true" || token.value === "false") {
      return semantics.literal(token.value === "true");
    }
    if (token.value === "null") {
      return semantics.literal(null);
    }
    return peek()?.value === "("
      ? call(token.value)
      : semantics.reference(token.value);
  };

  const comparison = (): T => {
    let left = primary();
    let next = peek();
    while (next?.kind === "op" && COMPARISONS.has(next.value)) {
      take();
      left = semantics.compare(next.value, left, primary());
      next = peek();
    }
    return left;
  };

  const and = (): T => {
    let left = comparison();
    while (peek()?.value === "&&") {
      take("&&");
      left = semantics.and(left, comparison());
    }
    return left;
  };

  const or = (): T => {
    let left = and();
    while (peek()?.value === "||") {
      take("||");
      left = semantics.or(left, and());
    }
    return left;
  };

  const value = or();
  if (position !== tokens.length) {
    return panic(`trailing tokens in: ${source}`);
  }
  return value;
};

/** Evaluates an `if:` condition (with or without `${{ }}`) in a partial context. */
export const evaluate = (source: string, context: Context): Result =>
  parseExpression(source, {
    literal: (value) => value,
    reference: (path) => {
      if (Object.hasOwn(context.values, path)) {
        return context.values[path] ?? null;
      }
      // A fallback's null is a known null (a missing property), not unknown.
      const value = context.fallback?.(path);
      return value === undefined ? UNKNOWN : value;
    },
    call: (name, args) => callFunction(name, args, context),
    not: (value) => {
      const truthy = isTruthy(value);
      return truthy === UNKNOWN ? UNKNOWN : !truthy;
    },
    compare,
    and: and3,
    or: or3,
  });

type ExpressionValueSource =
  | { type: "literal"; value: Value }
  | { type: "reference"; path: string }
  | { type: "computed" };

type ExpressionValueAlternative = {
  source: ExpressionValueSource;
  truthiness: "truthy" | "falsy";
};

const valueAlternatives = (
  source: ExpressionValueSource,
): ExpressionValueAlternative[] =>
  source.type === "literal"
    ? [{ source, truthiness: isTruthy(source.value) ? "truthy" : "falsy" }]
    : [
        { source, truthiness: "truthy" },
        { source, truthiness: "falsy" },
      ];

/**
 * Conservative value provenance through GitHub's operand-returning &&/||.
 * Comparisons and negation return booleans; calls stay unproven. Conditions
 * are never assumed constant or correlated, so unknown branches remain visible.
 */
export const expressionValueSources = (source: string) =>
  parseExpression(source, {
    literal: (value) => valueAlternatives({ type: "literal", value }),
    reference: (path) => valueAlternatives({ type: "reference", path }),
    call: () => valueAlternatives({ type: "computed" }),
    not: () => [
      ...valueAlternatives({ type: "literal", value: true }),
      ...valueAlternatives({ type: "literal", value: false }),
    ],
    compare: () => [
      ...valueAlternatives({ type: "literal", value: true }),
      ...valueAlternatives({ type: "literal", value: false }),
    ],
    and: (left, right) => [
      ...left.filter(({ truthiness }) => truthiness === "falsy"),
      ...(left.some(({ truthiness }) => truthiness === "truthy") ? right : []),
    ],
    or: (left, right) => [
      ...left.filter(({ truthiness }) => truthiness === "truthy"),
      ...(left.some(({ truthiness }) => truthiness === "falsy") ? right : []),
    ],
  }).map(({ source: valueSource }) => valueSource);

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
    computed.set(output, expression);
    if (reference !== undefined) {
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
