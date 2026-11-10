/**
 * A failed extraction or grading must stay a failure. Turning one into a
 * verdict (`missing`, `compliant`, …), a settled answer (`notStated`) or a
 * successful result makes a broken review look finished, so the grading and
 * extraction folders are read for the three shapes that do it:
 *
 * - `fallback-verdict`: `?? "missing"`, `|| "compliant"`: a verdict or
 *   settlement literal standing in for a value that is not there.
 * - `catch-verdict`: a catch clause, `.catch(fn)` handler or `Result.try` /
 *   `Result.tryPromise` `catch` that yields a verdict or settlement literal,
 *   or a `Result.ok(...)`.
 * - `error-branch-verdict`: the failure side of `Result.isError(x)`,
 *   `x.isErr()` or `Result.isOk(x)` (as a branch or a ternary) that yields
 *   the same.
 *
 * A failure is carried as a failure: a tagged error, or an outcome union whose
 * failed member every consumer must name (`AskOutcome`, `PropertyOutput`, the
 * graded/ungraded outcomes in review grading). The sites listed below predate
 * this census and are reviewed as legitimate; the list only shrinks.
 */
import { Glob } from "bun";
import { expect, test } from "bun:test";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";
import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";

import { guardEnforcesLine } from "../../../../../scripts/guard-rollouts.ts";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const repoRoot = path.resolve(apiRoot, "../..");
const CENSUS_FILE = "apps/api/src/lib/workflow/failure-verdict-census.test.ts";
const GOVERNED_DIRECTORIES = ["src/lib/workflow", "src/lib/document-review"];
// Registered in scripts/guard-rollouts: enforced on changed lines first.
const FAILURE_VERDICT_GUARD = "failure-verdict-census";

// Reviewed sites, keyed `file::owner::shape#n`. Remove an entry when its site
// goes; a new site is fixed, not added.
const FAILURE_VERDICT_EXCEPTIONS = {
  "src/lib/workflow/ai-generate-batch.ts::askSystemOne::error-branch-verdict#1":
    "System One cannot read the sources, so every property moves to the generative model, which answers it; nothing is settled from the failure.",
} as const satisfies Record<string, string>;

/** A verdict tier or answer settlement: a judgment about the document. */
const VERDICT_WORDS: ReadonlySet<string> = new Set([
  ...VERDICT_TIERS,
  "answered",
  "notStated",
  "not-stated",
  "notFoundInCutDocument",
]);

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** The expression under parentheses, type assertions and optional chains. */
const unwrap = (node: Node | null | undefined): Node | undefined => {
  let current = node ?? undefined;
  while (
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "ChainExpression"
  ) {
    current = current.expression;
  }
  return current;
};

/** The body of a function expression, the shape a handler is written in. */
const handlerBody = (node: Node | undefined): Node | null | undefined =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression"
    ? node.body
    : undefined;

const memberName = (node: Node | undefined): string | undefined =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

/** `Result.<name>(…)` */
const isResultCall = (node: Node | undefined, name: string): boolean => {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrap(call.callee);
  return (
    callee?.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Result" &&
    memberName(callee) === name
  );
};

/** `x.<name>()` on anything but `Result` itself. */
const isMethodCall = (node: Node | undefined, name: string): boolean => {
  const call = unwrap(node);
  return (
    call?.type === "CallExpression" &&
    memberName(unwrap(call.callee)) === name &&
    !isResultCall(call, name)
  );
};

const isVerdictWord = (node: Node | undefined): boolean => {
  const value = unwrap(node);
  return (
    value?.type === "Literal" &&
    typeof value.value === "string" &&
    VERDICT_WORDS.has(value.value)
  );
};

/** Whether `root`, outside any function nested in it, yields a verdict or
 *  settlement literal or a successful `Result`. */
const yieldsVerdict = (root: Node | null | undefined): boolean => {
  if (root === null || root === undefined) {
    return false;
  }
  let found = false;
  walk(root, (node) => {
    if (node !== root && FUNCTION_TYPES.has(node.type)) {
      return "skip-children";
    }
    if (isVerdictWord(node) || isResultCall(node, "ok")) {
      found = true;
    }
    return undefined;
  });
  return found;
};

/** Which side of a Result test runs on failure, or undefined for none. */
const failureSide = (
  condition: Node,
): "consequent" | "alternate" | undefined => {
  const node = unwrap(condition);
  if (node?.type === "UnaryExpression" && node.operator === "!") {
    const side = failureSide(node.argument);
    if (side === undefined) {
      return undefined;
    }
    return side === "consequent" ? "alternate" : "consequent";
  }
  if (isResultCall(node, "isError") || isMethodCall(node, "isErr")) {
    return "consequent";
  }
  if (isResultCall(node, "isOk") || isMethodCall(node, "isOk")) {
    return "alternate";
  }
  return undefined;
};

/** The failure handler a node carries, if it is one. */
const failureHandler = (
  node: Node,
  parent: Node | undefined,
): Node | null | undefined => {
  if (node.type === "CatchClause") {
    return node.body;
  }
  if (
    node.type === "CallExpression" &&
    memberName(unwrap(node.callee)) === "catch" &&
    node.arguments.length === 1
  ) {
    return handlerBody(unwrap(node.arguments.at(0)));
  }
  // `Result.try({ try, catch })` / `Result.tryPromise({ try, catch })`
  if (
    node.type === "Property" &&
    !node.computed &&
    node.key.type === "Identifier" &&
    node.key.name === "catch" &&
    parent?.type === "ObjectExpression"
  ) {
    return handlerBody(unwrap(node.value));
  }
  return undefined;
};

const functionName = (
  fn: Node,
  ancestors: readonly Node[],
  index: number,
): string | undefined => {
  if (
    (fn.type === "FunctionDeclaration" || fn.type === "FunctionExpression") &&
    fn.id
  ) {
    return fn.id.name;
  }
  // `const read = memo(async () => …)`: the name sits past the wrapping call.
  let parentIndex = index - 1;
  while (ancestors[parentIndex]?.type === "CallExpression") {
    parentIndex -= 1;
  }
  const parent = ancestors[parentIndex];
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier"
  ) {
    return parent.id.name;
  }
  if (
    (parent?.type === "Property" || parent?.type === "MethodDefinition") &&
    !parent.computed &&
    parent.key.type === "Identifier" &&
    // `Result.tryPromise({ try, catch })` callbacks belong to their caller.
    parent.key.name !== "try" &&
    parent.key.name !== "catch"
  ) {
    return parent.key.name;
  }
  return undefined;
};

/** The nearest named function around a node; callbacks fold into it. */
const ownerName = (ancestors: readonly Node[]): string => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor !== undefined && FUNCTION_TYPES.has(ancestor.type)) {
      const name = functionName(ancestor, ancestors, index);
      if (name !== undefined) {
        return name;
      }
    }
  }
  return "<module>";
};

type Shape = "fallback-verdict" | "catch-verdict" | "error-branch-verdict";

const shapeOf = (node: Node, parent: Node | undefined): Shape | undefined => {
  if (
    node.type === "LogicalExpression" &&
    (node.operator === "??" || node.operator === "||") &&
    isVerdictWord(node.right)
  ) {
    return "fallback-verdict";
  }
  const handler = failureHandler(node, parent);
  if (handler !== undefined) {
    return yieldsVerdict(handler) ? "catch-verdict" : undefined;
  }
  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    const side = failureSide(node.test);
    return side !== undefined && yieldsVerdict(node[side])
      ? "error-branch-verdict"
      : undefined;
  }
  return undefined;
};

/** Every failure-as-verdict site in one source, keyed like the exceptions. */
type Site = { key: string; line: number };

const failureVerdictSites = (file: string, source: string): Site[] => {
  const sites: Site[] = [];
  const ordinals = new Map<string, number>();
  const parsed = parseSource(file, source);
  walk(parsed.program, (node, ancestors) => {
    const shape = shapeOf(node, ancestors.at(-1));
    if (shape === undefined) {
      return;
    }
    const site = `${file}::${ownerName(ancestors)}::${shape}`;
    const ordinal = (ordinals.get(site) ?? 0) + 1;
    ordinals.set(site, ordinal);
    sites.push({
      key: `${site}#${String(ordinal)}`,
      line: parsed.locate(node.start).line,
    });
  });
  return sites;
};

const governedSources = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const directory of GOVERNED_DIRECTORIES) {
    for await (const relative of new Glob("**/*.ts").scan({
      cwd: path.join(apiRoot, directory),
      onlyFiles: true,
    })) {
      if (!relative.endsWith(".test.ts")) {
        files.push(`${directory}/${relative}`);
      }
    }
  }
  return files.toSorted();
};

test("grading and extraction never turn a failure into a verdict", async () => {
  const exceptions: ReadonlySet<string> = new Set(
    Object.keys(FAILURE_VERDICT_EXCEPTIONS),
  );
  const observed = new Set<string>();
  const unexpected: string[] = [];
  for (const file of await governedSources()) {
    const sites = failureVerdictSites(
      file,
      await Bun.file(path.join(apiRoot, file)).text(),
    );
    for (const { key, line } of sites) {
      observed.add(key);
      if (
        !exceptions.has(key) &&
        guardEnforcesLine({
          guard: FAILURE_VERDICT_GUARD,
          file: `apps/api/${file}`,
          line,
        })
      ) {
        unexpected.push(`${key} (line ${String(line)})`);
      }
    }
  }

  // A new site: carry the failure as an error or a failed outcome instead.
  expect(unexpected).toEqual([]);
  // A site that is gone: delete its exception.
  expect([...exceptions].filter((key) => !observed.has(key))).toEqual([]);
});

const lint = (lines: readonly string[]) =>
  failureVerdictSites("src/lib/workflow/example.ts", lines.join("\n")).map(
    ({ key }) => key,
  );

test("the census flags a verdict standing in for a missing value", () => {
  expect(
    lint([
      'const a = (x) => x ?? "missing";',
      'const b = (x) => x || ("compliant" as const);',
      'const c = (x) => x ?? "notStated";',
    ]),
  ).toEqual([
    "src/lib/workflow/example.ts::a::fallback-verdict#1",
    "src/lib/workflow/example.ts::b::fallback-verdict#1",
    "src/lib/workflow/example.ts::c::fallback-verdict#1",
  ]);
});

test("the census flags failure handlers that yield a verdict or success", () => {
  expect(
    lint([
      'const a = async () => { try { return await grade(); } catch { return "missing"; } };',
      'const b = async () => await grade().catch(() => "not-applicable");',
      "const c = async () => await Result.tryPromise({ try: grade, catch: () => Result.ok(null) });",
      'function d() { try { return grade(); } catch (error) { log(error); return { verdict: "deviation" }; } }',
    ]),
  ).toEqual([
    "src/lib/workflow/example.ts::a::catch-verdict#1",
    "src/lib/workflow/example.ts::b::catch-verdict#1",
    "src/lib/workflow/example.ts::c::catch-verdict#1",
    "src/lib/workflow/example.ts::d::catch-verdict#1",
  ]);
});

test("the census flags the failure side of a Result test", () => {
  expect(
    lint([
      'const a = (r) => { if (Result.isError(r)) { return "missing"; } return r.value; };',
      "const b = (r) => { if (r.isErr()) return Result.ok([]); return r; };",
      'const c = (r) => (Result.isOk(r) ? r.value : "compliant");',
      'const d = (r) => { if (!Result.isOk(r)) { settle("notStated"); } };',
      'const e = (r) => { if (!Result.isError(r)) { return r.value; } else { return "missing"; } };',
    ]),
  ).toEqual([
    "src/lib/workflow/example.ts::a::error-branch-verdict#1",
    "src/lib/workflow/example.ts::b::error-branch-verdict#1",
    "src/lib/workflow/example.ts::c::error-branch-verdict#1",
    "src/lib/workflow/example.ts::d::error-branch-verdict#1",
    "src/lib/workflow/example.ts::e::error-branch-verdict#1",
  ]);
});

test("the census permits propagation, failed outcomes and verdicts on the success side", () => {
  expect(
    lint([
      "const a = async () => { try { return await grade(); } catch (cause) { return new WorkflowIntegrationError({ message: 'Grading failed', cause }); } };",
      "const b = (r) => { if (Result.isError(r)) { return Result.err(r.error); } return r.value; };",
      'const c = (r) => (Result.isOk(r) ? "compliant" : UNGRADED);',
      'const d = (r) => { if (Result.isError(r)) { return { status: "ungraded" }; } return r; };',
      "const e = (x) => x ?? UNGRADED_VERDICT;",
      'const f = (x) => (x === undefined ? "ungraded" : x);',
      "const g = (r) => { if (Result.isError(r)) { const settle = () => Result.ok(1); return Result.err(r.error); } };",
    ]),
  ).toEqual([]);
});

const exceptionKeys = (source: string): string[] | undefined => {
  let keys: string[] | undefined;
  walk(parseSource("census.ts", source).program, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.id.name !== "FAILURE_VERDICT_EXCEPTIONS"
    ) {
      return;
    }
    const object = unwrap(node.init);
    if (object?.type !== "ObjectExpression") {
      return;
    }
    keys = object.properties.flatMap((entry) =>
      entry.type === "Property" &&
      entry.key.type === "Literal" &&
      typeof entry.key.value === "string"
        ? [entry.key.value]
        : [],
    );
  });
  return keys;
};

test("the exception list only shrinks", () => {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
  const sha = treeBaseRevision({ repoRoot });
  const listed = git(["ls-tree", "--name-only", sha, "--", CENSUS_FILE]);
  expect(listed.exitCode).toBe(0);
  // The census lands with its reviewed list; every later change shrinks it.
  if (listed.stdout.toString().trim() === "") {
    return;
  }
  const previous = git(["show", `${sha}:${CENSUS_FILE}`]);
  expect(previous.exitCode).toBe(0);
  const previousKeys = exceptionKeys(previous.stdout.toString());
  expect(previousKeys).toBeDefined();
  expect(
    Object.keys(FAILURE_VERDICT_EXCEPTIONS).filter(
      (key) => !(previousKeys ?? []).includes(key),
    ),
  ).toEqual([]);
});
