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

import { panic, Result as OperationResult } from "better-result";

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

type LiteralOutputConstraint = {
  readonly output: string;
  readonly operator: "==" | "!=";
  readonly value: string;
};

type OutputCondition =
  | { readonly type: "literal"; readonly value: boolean }
  | {
      readonly type: "constraint";
      readonly constraint: LiteralOutputConstraint;
    }
  | { readonly type: "opaque"; readonly polarity: "positive" | "negative" }
  | {
      readonly type: "and" | "or";
      readonly left: OutputCondition;
      readonly right: OutputCondition;
    };

const MAX_OUTPUT_DISJUNCTS = 64;

const ungroupTokens = (input: readonly Token[]): readonly Token[] => {
  let tokens = input;
  while (tokens.at(0)?.kind === "op" && tokens.at(0)?.value === "(") {
    let depth = 0;
    const end = tokens.findIndex((token) => {
      if (token.kind !== "op") {
        return false;
      }
      if (token.value === "(") {
        depth += 1;
      }
      if (token.value === ")") {
        depth -= 1;
      }
      return depth === 0;
    });
    if (end !== tokens.length - 1) {
      break;
    }
    tokens = tokens.slice(1, -1);
  }
  return tokens;
};

const topLevelOperator = (
  tokens: readonly Token[],
  operators: ReadonlySet<string>,
): number => {
  let depth = 0;
  return tokens.findIndex((token) => {
    if (token.kind !== "op") {
      return false;
    }
    if (token.value === "(") {
      depth += 1;
    }
    if (token.value === ")") {
      depth -= 1;
    }
    return depth === 0 && operators.has(token.value);
  });
};

const negateOutputCondition = (node: OutputCondition): OutputCondition => {
  switch (node.type) {
    case "literal":
      return { type: "literal", value: !node.value };
    case "constraint":
      return {
        type: "constraint",
        constraint: {
          output: node.constraint.output,
          operator: node.constraint.operator === "==" ? "!=" : "==",
          value: node.constraint.value,
        },
      };
    case "opaque":
      return {
        type: "opaque",
        polarity: node.polarity === "positive" ? "negative" : "positive",
      };
    case "and":
    case "or":
      return {
        type: node.type === "and" ? "or" : "and",
        left: negateOutputCondition(node.left),
        right: negateOutputCondition(node.right),
      };
    default:
      return panic(`Unknown output condition: ${String(node satisfies never)}`);
  }
};

const outputAtom = (
  tokens: readonly Token[],
  outputs: ReadonlySet<string>,
): OutputCondition => {
  const first = tokens.at(0);
  if (tokens.length === 1 && first?.kind === "word") {
    if (first.value === "true" || first.value === "false") {
      return { type: "literal", value: first.value === "true" };
    }
    if (outputs.has(first.value)) {
      return {
        type: "constraint",
        constraint: { output: first.value, operator: "!=", value: "" },
      };
    }
  }
  const operator = tokens.at(1);
  const last = tokens.at(2);
  if (
    tokens.length === 3 &&
    operator?.kind === "op" &&
    (operator.value === "==" || operator.value === "!=")
  ) {
    const reference = first?.kind === "word" ? first : last;
    const literal = first?.kind === "string" ? first : last;
    if (
      reference?.kind === "word" &&
      outputs.has(reference.value) &&
      literal?.kind === "string"
    ) {
      return {
        type: "constraint",
        constraint: {
          output: reference.value,
          operator: operator.value,
          value: literal.value.toLowerCase(),
        },
      };
    }
  }
  return { type: "opaque", polarity: "positive" };
};

const parseOutputCondition = (
  input: readonly Token[],
  outputs: ReadonlySet<string>,
): OutputCondition => {
  const tokens = ungroupTokens(input);
  if (tokens.length === 0) {
    return panic("Missing output condition atom");
  }
  for (const [operator, type] of [
    ["||", "or"],
    ["&&", "and"],
  ] as const) {
    const index = topLevelOperator(tokens, new Set([operator]));
    if (index !== -1) {
      return {
        type,
        left: parseOutputCondition(tokens.slice(0, index), outputs),
        right: parseOutputCondition(tokens.slice(index + 1), outputs),
      };
    }
  }
  if (
    tokens.at(0)?.kind === "op" &&
    tokens.at(0)?.value === "!" &&
    topLevelOperator(tokens, COMPARISONS) === -1
  ) {
    return negateOutputCondition(
      parseOutputCondition(tokens.slice(1), outputs),
    );
  }
  return outputAtom(tokens, outputs);
};

type OutputDisjunction =
  | {
      readonly type: "expanded";
      readonly terms: readonly (readonly LiteralOutputConstraint[])[];
    }
  | { readonly type: "unresolved"; readonly reason: string };

const expandOutputCondition = (node: OutputCondition): OutputDisjunction => {
  switch (node.type) {
    case "literal":
      return { type: "expanded", terms: node.value ? [[]] : [] };
    case "opaque":
      return { type: "expanded", terms: [[]] };
    case "constraint":
      return { type: "expanded", terms: [[node.constraint]] };
    case "and":
    case "or": {
      const left = expandOutputCondition(node.left);
      if (left.type === "unresolved") {
        return left;
      }
      const right = expandOutputCondition(node.right);
      if (right.type === "unresolved") {
        return right;
      }
      const count =
        node.type === "and"
          ? left.terms.length * right.terms.length
          : left.terms.length + right.terms.length;
      if (count > MAX_OUTPUT_DISJUNCTS) {
        return {
          type: "unresolved",
          reason: `output condition DNF exceeds ${MAX_OUTPUT_DISJUNCTS} disjuncts`,
        };
      }
      return {
        type: "expanded",
        terms:
          node.type === "or"
            ? [...left.terms, ...right.terms]
            : left.terms.flatMap((term) =>
                right.terms.map((other) => [...term, ...other]),
              ),
      };
    }
    default:
      return panic(`Unknown output condition: ${String(node satisfies never)}`);
  }
};

type LiteralOutputState = { equal?: string; excluded: Set<string> };

const outputConstraintConflict = (
  constraints: readonly LiteralOutputConstraint[],
): string | undefined => {
  const state = new Map<string, LiteralOutputState>();
  for (const constraint of constraints) {
    const entry: LiteralOutputState = state.get(constraint.output) ?? {
      excluded: new Set<string>(),
    };
    if (constraint.operator === "==") {
      if (
        (entry.equal !== undefined && entry.equal !== constraint.value) ||
        entry.excluded.has(constraint.value)
      ) {
        return constraint.output;
      }
      entry.equal = constraint.value;
    } else {
      if (entry.equal === constraint.value) {
        return constraint.output;
      }
      entry.excluded.add(constraint.value);
    }
    state.set(constraint.output, entry);
  }
  return undefined;
};

type ConjunctiveOutputConditionsOptions = {
  readonly conditions: readonly string[];
  readonly outputs: ReadonlySet<string>;
};

type ConjunctiveOutputConditionsResult =
  | { readonly type: "consistent" }
  | { readonly type: "contradictory"; readonly reason: string }
  | { readonly type: "unresolved"; readonly reason: string };

/** Bound output consistency without assigning values to other workflow atoms. */
export const conjunctiveOutputConditions = ({
  conditions,
  outputs,
}: ConjunctiveOutputConditionsOptions): ConjunctiveOutputConditionsResult => {
  const parsed = OperationResult.try(() => {
    let path: OutputCondition = { type: "literal", value: true };
    for (const condition of conditions) {
      evaluate(condition, { values: {} });
      path = {
        type: "and",
        left: path,
        right: parseOutputCondition(tokenize(condition), outputs),
      };
    }
    return path;
  });
  if (parsed.isErr()) {
    return { type: "unresolved", reason: "output condition parse failure" };
  }
  const disjunction = expandOutputCondition(parsed.value);
  if (disjunction.type === "unresolved") {
    return disjunction;
  }
  let conflict: string | undefined;
  for (const term of disjunction.terms) {
    const output = outputConstraintConflict(term);
    if (output === undefined) {
      return { type: "consistent" };
    }
    conflict ??= output;
  }
  return {
    type: "contradictory",
    reason:
      conflict === undefined
        ? "literal false condition"
        : `contradictory trusted output constraints: ${conflict}`,
  };
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
