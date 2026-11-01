// Every job in .github/workflows/ci.yml keeps a display name that resolves to
// a fixed set of names, and no two jobs can render the same name, so a job
// listed by the GitHub jobs API maps back to exactly one workflow job.
//
// A job's display name is its `name:`, or its key when it has none. Literal
// text renders as written. A `${{ ... }}` expression is allowed when every
// value it can take is a literal (`cond && 'a' || 'b'` renders `a` or `b`);
// it also counts its unrendered text, which GitHub shows for a job that never
// started. A matrix job may reference `matrix.<key>`, which renders one of its
// matrix values, and GitHub may append its matrix values as ` (...)`; a
// reusable-workflow job appends ` / <called job>`. Any other expression, or a
// name whose only identifying text is a matrix value, is unresolved.
import { readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW = ".github/workflows/ci.yml";

// --- Expression renderings ----------------------------------------------------

type Literal = string | number | boolean | null;
/** Every value an expression can take, or null when that is unknown. */
type Values = readonly Literal[] | null;
type Token =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "operator"; value: string }
  | { type: "identifier"; value: string };

const TOKEN =
  /\s*(?:'((?:[^']|'')*)'|(0x[0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|(&&|\|\||==|!=|<=|>=|[<>!()[\],.*])|([A-Za-z_][A-Za-z0-9_-]*))/uy;

const tokenize = (source: string): Token[] | null => {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (source.slice(TOKEN.lastIndex).trim() !== "") {
    const match = TOKEN.exec(source);
    if (match === null) {
      return null;
    }
    const [, text, number, operator, identifier] = match;
    if (text !== undefined) {
      tokens.push({ type: "string", value: text.replaceAll("''", "'") });
    } else if (number !== undefined) {
      tokens.push({ type: "number", value: Number(number) });
    } else if (operator !== undefined) {
      tokens.push({ type: "operator", value: operator });
    } else if (identifier !== undefined) {
      tokens.push({ type: "identifier", value: identifier });
    }
  }
  return tokens;
};

const truthy = (value: Literal) =>
  value !== false &&
  value !== null &&
  value !== 0 &&
  value !== "" &&
  !Number.isNaN(value);
// The falsy values an operand of unknown value can take.
const UNKNOWN_FALSY: readonly Literal[] = [false, null, 0, Number.NaN, ""];
const BOOLEAN: readonly Literal[] = [true, false];
// Functions whose result is always a boolean.
const PREDICATES = new Set([
  "always",
  "cancelled",
  "contains",
  "endswith",
  "failure",
  "startswith",
  "success",
]);

const union = (...sets: (readonly Literal[])[]) => [...new Set(sets.flat())];

const parse = (tokens: readonly Token[]): Values => {
  let index = 0;
  // Any token this reader does not expect leaves the expression unknown.
  let malformed = false;
  const peek = (value: string) => {
    const token = tokens[index];
    return token?.type === "operator" && token.value === value;
  };
  const expect = (value: string) => {
    if (peek(value)) {
      index += 1;
    } else {
      malformed = true;
    }
  };
  const or = (): Values => {
    let left = and();
    while (peek("||")) {
      index += 1;
      const right = and();
      // `a || b` is a when a is truthy, otherwise b.
      if (left !== null && left.some((value) => !truthy(value))) {
        left = right === null ? null : union(left.filter(truthy), right);
      }
    }
    return left;
  };
  const and = (): Values => {
    let left = comparison();
    while (peek("&&")) {
      index += 1;
      const right = comparison();
      // `a && b` is a when a is falsy, otherwise b.
      const falsy =
        left === null ? UNKNOWN_FALSY : left.filter((value) => !truthy(value));
      const truthyPossible = left === null || left.some(truthy);
      if (!truthyPossible) {
        left = falsy;
      } else {
        left = right === null ? null : union(falsy, right);
      }
    }
    return left;
  };
  const comparison = (): Values => {
    let left = unary();
    while (["==", "!=", "<", "<=", ">", ">="].some(peek)) {
      index += 1;
      unary();
      left = BOOLEAN;
    }
    return left;
  };
  const unary = (): Values => {
    if (!peek("!")) {
      return postfix();
    }
    index += 1;
    unary();
    return BOOLEAN;
  };
  const postfix = (): Values => {
    let value = primary();
    for (;;) {
      if (peek(".")) {
        index += 1;
        const token = tokens[index];
        if (
          token?.type !== "identifier" &&
          !(token?.type === "operator" && token.value === "*")
        ) {
          malformed = true;
        }
        index += 1;
        value = null;
      } else if (peek("[")) {
        index += 1;
        or();
        expect("]");
        value = null;
      } else {
        return value;
      }
    }
  };
  const primary = (): Values => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      malformed = true;
      return null;
    }
    if (token.type === "string" || token.type === "number") {
      return [token.value];
    }
    if (token.type === "operator") {
      if (token.value !== "(") {
        malformed = true;
        return null;
      }
      const value = or();
      expect(")");
      return value;
    }
    const name = token.value.toLowerCase();
    if (name === "true") {
      return [true];
    }
    if (name === "false") {
      return [false];
    }
    if (name === "null") {
      return [null];
    }
    if (!peek("(")) {
      return null;
    }
    index += 1;
    if (!peek(")")) {
      or();
      while (peek(",")) {
        index += 1;
        or();
      }
    }
    expect(")");
    return PREDICATES.has(name) ? BOOLEAN : null;
  };
  const value = or();
  return malformed || index !== tokens.length ? null : value;
};

const render = (value: Literal) => {
  if (value === null) {
    return "";
  }
  return typeof value === "string" ? value : String(value);
};

/**
 * The texts `${{ <source> }}` can render, or null when they are not a finite
 * set of literals known from the expression alone.
 */
export const expressionRenderings = (
  source: string,
): readonly string[] | null => {
  const tokens = tokenize(source);
  const values = tokens === null || tokens.length === 0 ? null : parse(tokens);
  return values === null ? null : [...new Set(values.map(render))];
};

// --- Display name patterns ----------------------------------------------------

/** One rendered name: literal text and "one or more characters" wildcards. */
type Piece = { type: "text"; text: string } | { type: "any" };
export type NamePattern = readonly Piece[];

const EXPRESSION = /(\$\{\{[\s\S]*?\}\})/u;
const MATRIX_REFERENCE = /^\s*matrix\.[A-Za-z_][\w-]*\s*$/u;

const text = (value: string): Piece[] =>
  value === "" ? [] : [{ type: "text", text: value }];
const ANY: Piece = { type: "any" };

type Job = Record<string, unknown>;
type NameVerdict =
  | { type: "resolved"; patterns: NamePattern[] }
  | { type: "unresolved"; reason: string };

const record = (value: unknown): value is Job =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every base followed by every option. */
const extend = (
  bases: readonly Piece[][],
  options: readonly Piece[][],
): Piece[][] =>
  options.flatMap((option) => bases.map((base) => [...base, ...option]));

/** Every name GitHub can show for this job, as patterns. */
export const jobNamePatterns = (key: string, job: Job): NameVerdict => {
  const strategy = job["strategy"];
  const matrix = record(strategy) && strategy["matrix"] !== undefined;
  const name = job["name"];
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    return { type: "unresolved", reason: "name is not a non-empty string" };
  }
  let bases: Piece[][] = [[]];
  let identified = false;
  for (const piece of (name ?? key).split(EXPRESSION)) {
    if (!piece.startsWith("${{")) {
      identified ||= /\w/u.test(piece);
      bases = extend(bases, [text(piece)]);
      continue;
    }
    const source = piece.slice(3, -2);
    if (matrix && MATRIX_REFERENCE.test(source)) {
      bases = extend(bases, [[ANY]]);
      continue;
    }
    const renderings = expressionRenderings(source);
    if (renderings === null) {
      return {
        type: "unresolved",
        reason: `${piece} does not render a fixed set of names`,
      };
    }
    identified ||= renderings.some((rendering) => /\w/u.test(rendering));
    // GitHub shows the unrendered text for a job that never started.
    bases = extend(bases, [...renderings, piece].map(text));
  }
  if (!identified) {
    return {
      type: "unresolved",
      reason: "only matrix values identify the job",
    };
  }
  const suffixes: Piece[][] = [
    [],
    ...(matrix ? [[...text(" ("), ANY, ...text(")")]] : []),
  ];
  const reusable = job["uses"] !== undefined;
  return {
    type: "resolved",
    patterns: bases.flatMap((base) =>
      suffixes.flatMap((suffix) => [
        [...base, ...suffix],
        ...(reusable ? [[...base, ...suffix, ...text(" / "), ANY]] : []),
      ]),
    ),
  };
};

// One character per step: a literal character, ANY (exactly one character) or
// STAR (zero or more). A wildcard piece is ANY followed by STAR.
type Step = string | "ANY" | "STAR";
const steps = (pattern: NamePattern): Step[] =>
  pattern.flatMap((piece): Step[] =>
    piece.type === "any" ? ["ANY", "STAR"] : [...piece.text],
  );

/** Whether some name matches both patterns. */
export const patternsOverlap = (
  left: NamePattern,
  right: NamePattern,
): boolean => {
  const a = steps(left);
  const b = steps(right);
  const seen = new Set<number>();
  const pending: [number, number][] = [[0, 0]];
  const visit = (i: number, j: number) => {
    const id = i * (b.length + 1) + j;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    pending.push([i, j]);
  };
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [i, j] = next;
    if (i === a.length && j === b.length) {
      return true;
    }
    const x = a[i];
    const y = b[j];
    if (x === "STAR") {
      visit(i + 1, j);
      if (y !== undefined) {
        visit(i, j + 1);
      }
    }
    if (y === "STAR") {
      visit(i, j + 1);
      if (x !== undefined) {
        visit(i + 1, j);
      }
    }
    if (
      x !== undefined &&
      y !== undefined &&
      x !== "STAR" &&
      y !== "STAR" &&
      (x === y || x === "ANY" || y === "ANY")
    ) {
      visit(i + 1, j + 1);
    }
  }
  return false;
};

const display = (pattern: NamePattern) =>
  pattern
    .map((piece) => (piece.type === "any" ? "<value>" : piece.text))
    .join("");

/** Every job whose name is unresolved, and every pair that can collide. */
export const checkCiJobNames = (jobs: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const resolved: { key: string; patterns: NamePattern[] }[] = [];
  for (const [key, job] of Object.entries(jobs)) {
    if (!record(job)) {
      errors.push(`${key}: job definition is not a mapping`);
      continue;
    }
    const verdict = jobNamePatterns(key, job);
    if (verdict.type === "unresolved") {
      errors.push(
        `${key}: unresolved name ${JSON.stringify(job["name"] ?? key)}: ${verdict.reason}`,
      );
      continue;
    }
    for (const other of resolved) {
      const collision = verdict.patterns
        .flatMap((pattern) =>
          other.patterns.map((theirs) => ({ pattern, theirs })),
        )
        .find(({ pattern, theirs }) => patternsOverlap(pattern, theirs));
      if (collision !== undefined) {
        errors.push(
          `${key}: ambiguous name ${JSON.stringify(display(collision.pattern))} can also be ${other.key}'s ${JSON.stringify(display(collision.theirs))}`,
        );
      }
    }
    resolved.push({ key, patterns: verdict.patterns });
  }
  return errors;
};

if (import.meta.main) {
  const file = path.join(process.cwd(), WORKFLOW);
  const workflow: unknown = Bun.YAML.parse(readFileSync(file, "utf-8"));
  const jobs = record(workflow) ? workflow["jobs"] : undefined;
  if (!record(jobs)) {
    process.stderr.write(`${WORKFLOW}: no jobs mapping\n`);
    process.exit(1);
  }
  const errors = checkCiJobNames(jobs);
  for (const error of errors) {
    process.stderr.write(`${WORKFLOW}: ${error}\n`);
  }
  if (errors.length > 0) {
    process.exit(1);
  }
  process.stdout.write(
    `CI job names: OK. ${Object.keys(jobs).length} jobs resolve to distinct names.\n`,
  );
}
