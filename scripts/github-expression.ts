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
// Output-condition analysis probes a parse and reports an unparsable
// expression as unresolved, so it needs the failure as a value.
const attempt = <T>(
  run: () => T,
): { ok: true; value: T } | { ok: false; error: unknown } => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
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
  | {
      readonly type: "bound";
      readonly source: string;
      readonly negated: boolean;
    }
  | { readonly type: "unresolved"; readonly reason: string }
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
    case "unresolved":
      return node;
    case "bound":
      return { ...node, negated: !node.negated };
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

export type OutputAliasDefinition = {
  readonly expression: string;
  readonly outputs: ReadonlyMap<string, string>;
};

type OutputParserOptions = {
  readonly outputs: ReadonlyMap<string, string>;
  readonly context: Context;
  readonly substitutions: ReadonlyMap<string, OutputCondition>;
  readonly resolveAlias?: (reference: string) => OutputCondition | undefined;
  readonly boundReferences?: ReadonlySet<string>;
};

const tokenSource = (tokens: readonly Token[]) =>
  tokens
    .map((token) =>
      token.kind === "string"
        ? `'${token.value.replaceAll("'", "''")}'`
        : String(token.value),
    )
    .join(" ");

const substitutedOutput = (reference: string, options: OutputParserOptions) =>
  options.substitutions.get(reference) ?? options.resolveAlias?.(reference);

const simpleOutputAtom = (
  tokens: readonly Token[],
  options: OutputParserOptions,
): OutputCondition | undefined => {
  const { outputs } = options;
  const first = tokens.at(0);
  if (tokens.length === 1 && first?.kind === "word") {
    if (first.value === "true" || first.value === "false") {
      return { type: "literal", value: first.value === "true" };
    }
    const substituted = substitutedOutput(first.value, options);
    if (substituted !== undefined) {
      return substituted.type === "unresolved"
        ? substituted
        : { type: "literal", value: true };
    }
    if (outputs.has(first.value)) {
      return {
        type: "constraint",
        constraint: {
          output:
            outputs.get(first.value) ??
            panic("Trusted output has no producer identity"),
          operator: "!=",
          value: "",
        },
      };
    }
  }
  return undefined;
};

const comparisonOutputAtom = (
  tokens: readonly Token[],
  options: OutputParserOptions,
): OutputCondition | undefined => {
  const { outputs } = options;
  const first = tokens.at(0);
  const operator = tokens.at(1);
  const last = tokens.at(2);
  if (
    tokens.length === 3 &&
    operator?.kind === "op" &&
    (operator.value === "==" || operator.value === "!=")
  ) {
    const reference = first?.kind === "word" ? first : last;
    const literal = first?.kind === "string" ? first : last;
    if (reference?.kind === "word" && literal?.kind === "string") {
      const substituted = substitutedOutput(reference.value, options);
      if (substituted !== undefined) {
        if (substituted.type === "unresolved") {
          return substituted;
        }
        const value = literal.value.toLowerCase();
        let equal: OutputCondition = { type: "literal", value: false };
        if (value === "true") {
          equal = substituted;
        }
        if (value === "false") {
          equal = negateOutputCondition(substituted);
        }
        return operator.value === "==" ? equal : negateOutputCondition(equal);
      }
    }
    if (
      reference?.kind === "word" &&
      outputs.has(reference.value) &&
      literal?.kind === "string"
    ) {
      return {
        type: "constraint",
        constraint: {
          output:
            outputs.get(reference.value) ??
            panic("Trusted output has no producer identity"),
          operator: operator.value,
          value: literal.value.toLowerCase(),
        },
      };
    }
  }
  return undefined;
};

const contextualOutputAtom = (
  tokens: readonly Token[],
  options: OutputParserOptions,
): OutputCondition => {
  const { context } = options;
  const first = tokens.at(0);
  const operator = tokens.at(1);
  const last = tokens.at(2);
  const source = tokenSource(tokens);
  if (options.boundReferences !== undefined) {
    const reference = first?.kind === "word" ? first : last;
    const literal = first?.kind === "word" ? last : first;
    const bound =
      reference?.kind === "word" &&
      options.boundReferences.has(reference.value);
    const comparison =
      tokens.length === 3 &&
      operator?.kind === "op" &&
      (operator.value === "==" || operator.value === "!=") &&
      (literal?.kind === "string" ||
        (literal?.kind === "word" &&
          ["true", "false", "null"].includes(literal.value)));
    if (bound && (tokens.length === 1 || comparison)) {
      return { type: "bound", source, negated: false };
    }
    return {
      type: "unresolved",
      reason: `composite output contains unsupported atom: ${source}`,
    };
  }
  const value = isTruthy(evaluate(source, context));
  return value === UNKNOWN
    ? { type: "unresolved", reason: `unresolved condition atom: ${source}` }
    : { type: "literal", value };
};

const outputAtom = (
  tokens: readonly Token[],
  options: OutputParserOptions,
): OutputCondition =>
  simpleOutputAtom(tokens, options) ??
  comparisonOutputAtom(tokens, options) ??
  contextualOutputAtom(tokens, options);

const parseOutputCondition = (
  input: readonly Token[],
  options: OutputParserOptions,
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
        left: parseOutputCondition(tokens.slice(0, index), options),
        right: parseOutputCondition(tokens.slice(index + 1), options),
      };
    }
  }
  if (
    tokens.at(0)?.kind === "op" &&
    tokens.at(0)?.value === "!" &&
    topLevelOperator(tokens, COMPARISONS) === -1
  ) {
    return negateOutputCondition(
      parseOutputCondition(tokens.slice(1), options),
    );
  }
  return outputAtom(tokens, options);
};

type CompileOutputAliasesOptions = {
  readonly aliases: ReadonlyMap<string, OutputAliasDefinition>;
  readonly boundReferences: ReadonlySet<string>;
};

const hasBooleanOutputValue = (input: readonly Token[]): boolean => {
  const tokens = ungroupTokens(input);
  for (const operator of ["||", "&&"]) {
    const index = topLevelOperator(tokens, new Set([operator]));
    if (index !== -1) {
      return (
        hasBooleanOutputValue(tokens.slice(0, index)) &&
        hasBooleanOutputValue(tokens.slice(index + 1))
      );
    }
  }
  const first = tokens.at(0);
  return (
    topLevelOperator(tokens, COMPARISONS) !== -1 ||
    (first?.kind === "op" && first.value === "!") ||
    (tokens.length === 1 &&
      first?.kind === "word" &&
      ["true", "false"].includes(first.value))
  );
};

export const compileOutputAliases = ({
  aliases,
  boundReferences,
}: CompileOutputAliasesOptions) => {
  const compiled = new Map<string, OutputCondition>();
  const visiting = new Set<string>();
  const resolveAlias = (reference: string): OutputCondition | undefined => {
    const cached = compiled.get(reference);
    if (cached !== undefined) {
      return cached;
    }
    const definition = aliases.get(reference);
    if (definition === undefined) {
      return undefined;
    }
    if (visiting.has(reference)) {
      return {
        type: "unresolved",
        reason: `composite output alias cycle: ${reference}`,
      };
    }
    visiting.add(reference);
    const parsed = attempt(() => {
      const tokens = ungroupTokens(tokenize(definition.expression));
      const first = tokens.at(0);
      // Copying an output preserves its 'true'/'false' string value.
      if (tokens.length === 1 && first?.kind === "word") {
        const copied = resolveAlias(first.value);
        if (copied !== undefined) {
          return copied;
        }
      }
      if (!hasBooleanOutputValue(tokens)) {
        return {
          type: "unresolved",
          reason: `composite output may be an empty or non-boolean string: ${reference}`,
        } as const;
      }
      return parseOutputCondition(tokens, {
        outputs: definition.outputs,
        context: { values: {} },
        substitutions: new Map(),
        resolveAlias,
        boundReferences,
      });
    });
    const node: OutputCondition = parsed.ok
      ? parsed.value
      : {
          type: "unresolved",
          reason: `composite output parse failure: ${reference}`,
        };
    visiting.delete(reference);
    compiled.set(reference, node);
    return node;
  };
  for (const reference of aliases.keys()) {
    resolveAlias(reference);
  }
  return compiled;
};

type OutputDisjunction =
  | {
      readonly type: "expanded";
      readonly terms: readonly {
        readonly constraints: readonly LiteralOutputConstraint[];
        readonly blockers: readonly string[];
      }[];
    }
  | { readonly type: "unresolved"; readonly reason: string };

const expandOutputCondition = (
  node: OutputCondition,
  context: Context,
): OutputDisjunction => {
  switch (node.type) {
    case "unresolved":
      return {
        type: "expanded",
        terms: [{ constraints: [], blockers: [node.reason] }],
      };
    case "bound": {
      const value = isTruthy(evaluate(node.source, context));
      if (value === UNKNOWN) {
        return {
          type: "expanded",
          terms: [
            {
              constraints: [],
              blockers: [
                `composite output has unresolved bound atom: ${node.source}`,
              ],
            },
          ],
        };
      }
      return {
        type: "expanded",
        terms: (node.negated ? !value : value)
          ? [{ constraints: [], blockers: [] }]
          : [],
      };
    }
    case "literal":
      return {
        type: "expanded",
        terms: node.value ? [{ constraints: [], blockers: [] }] : [],
      };
    case "constraint":
      return {
        type: "expanded",
        terms: [{ constraints: [node.constraint], blockers: [] }],
      };
    case "and":
    case "or": {
      const left = expandOutputCondition(node.left, context);
      if (left.type === "unresolved") {
        return left;
      }
      const right = expandOutputCondition(node.right, context);
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
                right.terms.map((other) => ({
                  constraints: [...term.constraints, ...other.constraints],
                  blockers: [...term.blockers, ...other.blockers],
                })),
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
  readonly outputs: ReadonlyMap<string, string>;
  readonly context?: Context;
  readonly substitutions?: ReturnType<typeof compileOutputAliases>;
};

type ConjunctiveOutputConditionsResult =
  | { readonly type: "consistent" }
  | { readonly type: "contradictory"; readonly reason: string }
  | { readonly type: "unresolved"; readonly reason: string };

/** Bound output consistency without assigning values to other workflow atoms. */
export const conjunctiveOutputConditions = ({
  conditions,
  outputs,
  context = { values: {} },
  substitutions = new Map(),
}: ConjunctiveOutputConditionsOptions): ConjunctiveOutputConditionsResult => {
  const parsed = attempt(() => {
    let path: OutputCondition = { type: "literal", value: true };
    for (const condition of conditions) {
      evaluate(condition, { values: {} });
      path = {
        type: "and",
        left: path,
        right: parseOutputCondition(tokenize(condition), {
          outputs,
          context,
          substitutions,
        }),
      };
    }
    return path;
  });
  if (!parsed.ok) {
    return { type: "unresolved", reason: "output condition parse failure" };
  }
  const disjunction = expandOutputCondition(parsed.value, context);
  if (disjunction.type === "unresolved") {
    return disjunction;
  }
  let conflict: string | undefined;
  const blockers = new Set<string>();
  for (const term of disjunction.terms) {
    if (term.blockers.length > 0) {
      for (const blocker of term.blockers) {
        blockers.add(blocker);
      }
      continue;
    }
    const output = outputConstraintConflict(term.constraints);
    if (output === undefined) {
      return { type: "consistent" };
    }
    conflict ??= output;
  }
  if (blockers.size > 0) {
    return {
      type: "unresolved",
      reason: `unresolved condition disjuncts: ${[...blockers].join("; ")}`,
    };
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
    // A fallback's null is a known null (a missing property), not unknown.
    const value = context.fallback?.(path);
    return value === undefined ? UNKNOWN : value;
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
