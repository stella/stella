// Hold every BullMQ queue to a declared authority and every member-run queue
// to the run actor, with a shrink-only, reasoned baseline
// (scripts/queue-authority-baseline.json).
//
// The registry is `QUEUE_AUTHORITY` in apps/api/src/lib/member-run-queues.ts.
// Its type requires a row per queue in the BullMQ host table; this script
// checks what the type cannot:
//
//   errors   (never baselined) a queue the host table and the registry
//            disagree on; a row without a reason; a BullMQ `Worker` whose
//            queue name does not resolve statically to string literals; a
//            row whose worker module consumes no `Worker` on that queue; a
//            `Worker` on a queue the registry assigns to another module (or
//            to none); a `MEMBER_RUN_QUEUES` entry the registry does not
//            classify as a member run of that module.
//   members  (baselined, keyed without line numbers) a member-run queue whose
//            worker module never calls the imported `createRootRunActor`
//            (`<queue>::run-actor`); a member-run module the pinned-handle
//            allowlist still admits (`<queue>::pinned-handles::<file>`); a
//            member-run queue without an `*.integration.test.ts` that declares
//            an active bun:test case per revocation title
//            (`<queue>::revocation-test`).
//
// Modes:
//   bun scripts/queue-authority.ts --check [--base <ref>]   (default base:
//     $BASE_SHA, then origin/main)
//   bun scripts/queue-authority.ts --write
//   bun scripts/queue-authority.ts --self-test

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import {
  MEMBER_RUN_QUEUES,
  MEMBER_RUN_REVOCATION_CASES,
  QUEUE_AUTHORITY,
} from "../apps/api/src/lib/member-run-queues.ts";
import type { QueueAuthorityEntry } from "../apps/api/src/lib/member-run-queues.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { addedEntries, runLedgerMembershipGuard } from "./ledger-membership.ts";
import { OWNERSHIP } from "./ownership.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.queueAuthority;
const API_SOURCE = "apps/api/src/";
const HOST_TABLE_FILE = "apps/api/src/lib/bullmq-queue.ts";
const HOST_TABLE_NAME = "BULLMQ_QUEUE_HOSTS";
const PINNED_HANDLES_ROW = "pinned-workspace-handles";
const RUN_ACTOR = "createRootRunActor";
const RUN_ACTOR_MODULE = "@/api/lib/root-scoped-db";
const REVOCATION_TEST_SUFFIX = ".integration.test.ts";

const BASELINE_SCHEMA = v.object({
  comment: v.string(),
  members: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
});
type Baseline = v.InferOutput<typeof BASELINE_SCHEMA>;

const REASONS = {
  runActor:
    "Member run on pinned handles; build them with createRootRunActor, read inputs through inputDb, and list the queue in MEMBER_RUN_QUEUES.",
  pinnedHandles:
    "Member-run module still allowed pinned workspace handles; move its reads to the run actor and drop it from the pinned-workspace-handles allowlist.",
  revocationTest:
    "No integration test removes the requester's access after the run is queued; add one per revocation case and name it in revocationTest.",
} as const;

type AuditInput = {
  hostQueues: readonly string[];
  registry: Readonly<Record<string, QueueAuthorityEntry>>;
  memberRunQueues: readonly { queue: string; module: string }[];
  /**
   * Modules that construct a BullMQ `Worker`, with the queue names those
   * workers consume; `null` when a queue name does not resolve statically.
   */
  workerQueues: ReadonlyMap<string, readonly string[] | null>;
  pinnedAllowed: ReadonlySet<string>;
  /** Repository-relative read; `null` when the file does not exist. */
  readFile: (relativePath: string) => string | null;
};

type Member = { key: string; reason: string };
type Audit = { errors: string[]; members: Member[] };

const auditRegistry = (input: AuditInput, errors: string[]) => {
  const hosted = new Set(input.hostQueues);
  for (const queue of input.hostQueues) {
    if (!(queue in input.registry)) {
      errors.push(`Queue without an authority row: ${queue}`);
    }
  }
  for (const [queue, entry] of Object.entries(input.registry)) {
    if (!hosted.has(queue)) {
      errors.push(`Authority row for a queue the host table lacks: ${queue}`);
    }
    if (entry.reason.trim() === "") {
      errors.push(`Authority row without a reason: ${queue}`);
    }
    const consumed = input.workerQueues.get(entry.worker);
    if (consumed === undefined) {
      errors.push(
        `Declared worker module constructs no BullMQ Worker: ${queue} -> ${entry.worker}`,
      );
    } else if (consumed !== null && !consumed.includes(queue)) {
      errors.push(
        `Declared worker module has no Worker on its queue: ${queue} -> ${entry.worker}`,
      );
    }
    for (const executor of entry.executors ?? []) {
      if (input.readFile(executor) === null) {
        errors.push(
          `Declared executor does not exist: ${queue} -> ${executor}`,
        );
      }
    }
  }
  for (const [module, queues] of input.workerQueues) {
    if (queues === null) {
      errors.push(
        `BullMQ Worker queue name does not resolve to string literals: ${module}`,
      );
      continue;
    }
    for (const queue of queues) {
      const owner = input.registry[queue]?.worker;
      if (owner !== module) {
        errors.push(
          owner === undefined
            ? `BullMQ Worker outside the queue authority registry: ${module} (${queue})`
            : `BullMQ Worker on ${queue} in ${module}, but the registry assigns it to ${owner}`,
        );
      }
    }
  }
  for (const { queue, module } of input.memberRunQueues) {
    const entry = input.registry[queue];
    if (entry?.authority !== "member-run" || entry.worker !== module) {
      errors.push(
        `MEMBER_RUN_QUEUES lists ${queue} (${module}), but the registry does not classify it as a member run of that module`,
      );
    }
  }
};

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isSatisfiesExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;

const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

const parseSource = (name: string, source: string): ts.SourceFile =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);

const findNodes = <T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

type ImportBinding = { module: string; imported: string };

/** Value (not type-only) named imports, keyed by local name. */
const importBindings = (file: ts.SourceFile): Map<string, ImportBinding> => {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) {
      continue;
    }
    for (const element of named.elements) {
      if (!element.isTypeOnly) {
        bindings.set(element.name.text, {
          module: statement.moduleSpecifier.text,
          imported: (element.propertyName ?? element.name).text,
        });
      }
    }
  }
  return bindings;
};

/** Local names bound to `imported` from `module`. */
const importedAs = (
  file: ts.SourceFile,
  module: string,
  imported: string,
): Set<string> =>
  new Set(
    [...importBindings(file)]
      .filter(
        ([, binding]) =>
          binding.module === module && binding.imported === imported,
      )
      .map(([local]) => local),
  );

/** Whether the module calls the `createRootRunActor` it imports. */
const callsRunActor = (source: string): boolean => {
  const file = parseSource("worker.ts", source);
  const locals = importedAs(file, RUN_ACTOR_MODULE, RUN_ACTOR);
  return findNodes(file, ts.isCallExpression).some(
    (call) =>
      ts.isIdentifier(call.expression) && locals.has(call.expression.text),
  );
};

const INACTIVE_MODIFIERS = new Set([
  "if",
  "skip",
  "skipIf",
  "todo",
  "todoIf",
  "failing",
]);

/** Whether `node` sits inside a skipped, conditional or todo suite or test. */
const insideInactiveBlock = (node: ts.Node): boolean => {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      const callee = ts.isCallExpression(current.expression)
        ? current.expression.expression
        : current.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        INACTIVE_MODIFIERS.has(callee.name.text)
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

/**
 * Titles of the active bun:test cases in `source`: a plain `test`/`it` call
 * imported from bun:test with a literal title and a function body, outside
 * any skipped or conditional block. Comments and constants do not count.
 */
const activeTestTitles = (source: string): Set<string> => {
  const file = parseSource("revocation.test.ts", source);
  const runners = new Set([
    ...importedAs(file, "bun:test", "test"),
    ...importedAs(file, "bun:test", "it"),
  ]);
  const titles = new Set<string>();
  for (const call of findNodes(file, ts.isCallExpression)) {
    const [title, body] = call.arguments;
    if (
      ts.isIdentifier(call.expression) &&
      runners.has(call.expression.text) &&
      title !== undefined &&
      ts.isStringLiteralLike(title) &&
      body !== undefined &&
      (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
      !insideInactiveBlock(call)
    ) {
      titles.add(title.text);
    }
  }
  return titles;
};

const API_ALIAS = "@/api/";
const MAX_RESOLVE_DEPTH = 6;

const resolveModulePath = (from: string, specifier: string): string | null => {
  let base: string;
  if (specifier.startsWith(API_ALIAS)) {
    base = path.posix.join(API_SOURCE, specifier.slice(API_ALIAS.length));
  } else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  } else {
    return null;
  }
  return `${base.replace(/\.ts$/u, "")}.ts`;
};

const declarationInitializer = (
  file: ts.SourceFile,
  name: string,
): ts.Expression | undefined =>
  findNodes(file, ts.isVariableDeclaration).find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name,
  )?.initializer;

type ResolveContext = {
  relativePath: string;
  file: ts.SourceFile;
  readFile: AuditInput["readFile"];
  depth: number;
};

/**
 * The string literals an expression can evaluate to, following local
 * constants, named imports (relative or `@/api/`), element access into an
 * object literal and its values. `null` when any step is not a literal.
 */
const resolveStrings = (
  expression: ts.Expression,
  context: ResolveContext,
): string[] | null => {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) {
    return [node.text];
  }
  if (context.depth > MAX_RESOLVE_DEPTH) {
    return null;
  }
  const deeper = { ...context, depth: context.depth + 1 };
  if (ts.isElementAccessExpression(node)) {
    return resolveStrings(node.expression, deeper);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const values: string[] = [];
    for (const property of node.properties) {
      const resolved = ts.isPropertyAssignment(property)
        ? resolveStrings(property.initializer, deeper)
        : null;
      if (resolved === null) {
        return null;
      }
      values.push(...resolved);
    }
    return values;
  }
  if (!ts.isIdentifier(node)) {
    return null;
  }
  const local = declarationInitializer(context.file, node.text);
  if (local !== undefined) {
    return resolveStrings(local, deeper);
  }
  const binding = importBindings(context.file).get(node.text);
  const target =
    binding === undefined
      ? null
      : resolveModulePath(context.relativePath, binding.module);
  const source = target === null ? null : context.readFile(target);
  if (binding === undefined || target === null || source === null) {
    return null;
  }
  const file = parseSource(target, source);
  const exported = declarationInitializer(file, binding.imported);
  return exported === undefined
    ? null
    : resolveStrings(exported, { ...deeper, relativePath: target, file });
};

/**
 * Queue names consumed by the BullMQ `Worker`s a module constructs:
 * `undefined` when it constructs none, `null` when a queue name does not
 * resolve statically.
 */
const workerQueueNames = (
  relativePath: string,
  source: string,
  readFile: AuditInput["readFile"],
): readonly string[] | null | undefined => {
  if (!source.includes("bullmq")) {
    return undefined;
  }
  const file = parseSource(relativePath, source);
  const locals = importedAs(file, "bullmq", "Worker");
  const constructions = findNodes(file, ts.isNewExpression).filter(
    (node) =>
      ts.isIdentifier(node.expression) && locals.has(node.expression.text),
  );
  if (constructions.length === 0) {
    return undefined;
  }
  const queues = new Set<string>();
  for (const construction of constructions) {
    const first = construction.arguments?.at(0);
    const names =
      first === undefined
        ? null
        : resolveStrings(first, { relativePath, file, readFile, depth: 0 });
    if (names === null) {
      return null;
    }
    for (const name of names) {
      queues.add(name);
    }
  }
  return [...queues].toSorted();
};

const revocationGap = (
  entry: QueueAuthorityEntry,
  readFile: AuditInput["readFile"],
): string | null => {
  if (entry.revocationTest === undefined) {
    return REASONS.revocationTest;
  }
  if (!entry.revocationTest.endsWith(REVOCATION_TEST_SUFFIX)) {
    return `revocationTest ${entry.revocationTest} is not an integration test (*${REVOCATION_TEST_SUFFIX}).`;
  }
  const source = readFile(entry.revocationTest);
  if (source === null) {
    return `revocationTest ${entry.revocationTest} does not exist.`;
  }
  const active = activeTestTitles(source);
  const missing = MEMBER_RUN_REVOCATION_CASES.filter(
    (title) => !active.has(title),
  );
  return missing.length === 0
    ? null
    : `${entry.revocationTest} lacks: ${missing.join("; ")}.`;
};

const auditQueueAuthority = (input: AuditInput): Audit => {
  const errors: string[] = [];
  auditRegistry(input, errors);
  const onActor = new Set(input.memberRunQueues.map(({ queue }) => queue));
  const members: Member[] = [];
  for (const [queue, entry] of Object.entries(input.registry)) {
    if (entry.authority !== "member-run") {
      continue;
    }
    const usesActor =
      onActor.has(queue) && callsRunActor(input.readFile(entry.worker) ?? "");
    if (!usesActor) {
      members.push({ key: `${queue}::run-actor`, reason: REASONS.runActor });
    }
    for (const file of [entry.worker, ...(entry.executors ?? [])]) {
      if (input.pinnedAllowed.has(file)) {
        members.push({
          key: `${queue}::pinned-handles::${file}`,
          reason: REASONS.pinnedHandles,
        });
      }
    }
    const gap = revocationGap(entry, input.readFile);
    if (gap !== null) {
      members.push({ key: `${queue}::revocation-test`, reason: gap });
    }
  }
  members.sort((left, right) => left.key.localeCompare(right.key));
  return { errors, members };
};

/** Keys of the object literal assigned to `name` in `source`. */
const objectKeys = (source: string, name: string): string[] | null => {
  const file = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        const value = unwrap(declaration.initializer);
        if (!ts.isObjectLiteralExpression(value)) {
          return null;
        }
        return value.properties.flatMap((property) => {
          const key =
            ts.isPropertyAssignment(property) && propertyName(property.name);
          return typeof key === "string" ? [key] : [];
        });
      }
    }
  }
  return null;
};

const isProductionSource = (relativePath: string): boolean =>
  !/\.(test|type-test)\.ts$/u.test(relativePath) &&
  !/(^|\/)(__fixtures__|__tests__|tests)\//u.test(relativePath);

const readRepoFile = (relativePath: string): string | null => {
  const absolute = path.join(ROOT, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
};

const treeInput = (): AuditInput => {
  const hostQueues = objectKeys(
    readRepoFile(HOST_TABLE_FILE) ?? "",
    HOST_TABLE_NAME,
  );
  if (hostQueues === null) {
    return panic(`${HOST_TABLE_NAME} not found in ${HOST_TABLE_FILE}`);
  }
  const workerQueues = new Map<string, readonly string[] | null>();
  for (const file of [
    ...new Bun.Glob(`${API_SOURCE}**/*.ts`).scanSync({ cwd: ROOT }),
  ]
    .filter(isProductionSource)
    .toSorted()) {
    const queues = workerQueueNames(
      file,
      readRepoFile(file) ?? "",
      readRepoFile,
    );
    if (queues !== undefined) {
      workerQueues.set(file, queues);
    }
  }
  const pinnedRow = OWNERSHIP.find(({ id }) => id === PINNED_HANDLES_ROW);
  if (pinnedRow?.enforcement.kind !== "import") {
    return panic(`ownership row ${PINNED_HANDLES_ROW} is not an import row`);
  }
  return {
    hostQueues,
    registry: QUEUE_AUTHORITY,
    memberRunQueues: MEMBER_RUN_QUEUES,
    workerQueues,
    pinnedAllowed: new Set(
      pinnedRow.enforcement.allowed.map(({ path: file }) => file),
    ),
    readFile: readRepoFile,
  };
};

const parseBaseline = (text: string, label: string): Baseline => {
  const parsed = v.safeParse(BASELINE_SCHEMA, JSON.parse(text));
  if (!parsed.success) {
    return panic(`${label}: ${v.summarize(parsed.issues)}`);
  }
  return parsed.output;
};

const readBaseline = (): Baseline =>
  parseBaseline(readRepoFile(BASELINE) ?? "", BASELINE);

const reportErrors = (errors: readonly string[]): boolean => {
  for (const error of errors) {
    console.error(error);
  }
  return errors.length > 0;
};

const write = (): number => {
  const { errors, members } = auditQueueAuthority(treeInput());
  if (reportErrors(errors)) {
    return 1;
  }
  const previous = readBaseline();
  const next: Baseline = {
    comment: previous.comment,
    members: Object.fromEntries(
      members.map(({ key, reason }) => [key, previous.members[key] ?? reason]),
    ),
  };
  writeFileSync(
    path.join(ROOT, BASELINE),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  console.log(
    `Queue authority baseline written: ${String(members.length)} members.`,
  );
  return 0;
};

/** Members found but not listed, and listed members no longer found. */
const baselineDifference = (
  found: readonly string[],
  listed: readonly string[],
) => ({
  added: found.filter((key) => !listed.includes(key)),
  stale: listed.filter((key) => !found.includes(key)),
});

const check = (args: readonly string[]): number => {
  const { errors, members } = auditQueueAuthority(treeInput());
  const baseline = readBaseline();
  const { added, stale } = baselineDifference(
    members.map(({ key }) => key),
    Object.keys(baseline.members),
  );
  const failures = [
    ...errors,
    ...added.map(
      (key) =>
        `New member-run gap (build the run with createRootRunActor and test revocation): ${key}`,
    ),
    ...stale.map(
      (key) => `Closed member-run gap still listed (run --write): ${key}`,
    ),
  ];
  reportErrors(failures);
  const baseIndex = args.indexOf("--base");
  const base =
    (baseIndex === -1 ? undefined : args[baseIndex + 1]) ??
    process.env["BASE_SHA"] ??
    "origin/main";
  const membership = runLedgerMembershipGuard({
    ledgerRel: BASELINE,
    repoRoot: ROOT,
    parseLedger: (text, label) =>
      Object.keys(parseBaseline(text, label).members),
    label: "queue-authority",
    remediation:
      "build a new member run with createRootRunActor and a revocation test instead of listing it",
    args: ["--base", base === "" ? "origin/main" : base],
  });
  if (failures.length > 0 || membership !== 0) {
    return 1;
  }
  console.log(
    `Queue authority: ${String(Object.keys(QUEUE_AUTHORITY).length)} queues classified, ${String(members.length)} baselined members, exact set verified.`,
  );
  return 0;
};

const SELF_TEST_WORKER = `
  import { Worker as BullWorker, type Job } from "bullmq";
  import { NAMES } from "@/api/lib/names";
  const LOCAL = "local";
  const name = NAMES[kind];
  export const start = () => [
    new BullWorker<Job>(LOCAL, async () => {}),
    new BullWorker<Job>(name, async () => {}),
  ];
`;
const SELF_TEST_NAMES = `
  export const NAMES = { [K.a]: "imported-a", b: "imported-b" } as const;
`;
const SELF_TEST_WEB_WORKER = `
  export const start = () => new Worker(new URL("./w.ts", import.meta.url));
`;
const SELF_TEST_DYNAMIC_WORKER = `
  import { Worker } from "bullmq";
  export const start = (queue: string) => new Worker(queue, async () => {});
`;
const workerOn = (queue: string) =>
  `import { Worker } from "bullmq"; new Worker("${queue}", async () => {});`;
const SELF_TEST_ACTOR = `
  import { ${RUN_ACTOR} as actorFor } from "${RUN_ACTOR_MODULE}";
  const actor = actorFor(data);
`;
const SELF_TEST_ACTOR_TEXT_ONLY = `
  // ${RUN_ACTOR}(data) is planned
  const note = "${RUN_ACTOR}(data)";
  const ${RUN_ACTOR} = (value: unknown) => value;
  ${RUN_ACTOR}(data);
`;
const SELF_TEST_BUN_TEST = 'import { describe, test } from "bun:test";\n';
const revocationCase = (title: string, call = "test") =>
  `${call}("${title}", async () => {});`;
const SELF_TEST_REVOCATION =
  SELF_TEST_BUN_TEST +
  MEMBER_RUN_REVOCATION_CASES.map((title) => revocationCase(title)).join("\n");
const SELF_TEST_INACTIVE_REVOCATIONS = [
  // Titles only in comments and constants.
  `${SELF_TEST_BUN_TEST}// ${MEMBER_RUN_REVOCATION_CASES.join(" ")}\nconst titles = ${JSON.stringify(MEMBER_RUN_REVOCATION_CASES)};`,
  // A skipped case.
  `${SELF_TEST_BUN_TEST}${revocationCase(MEMBER_RUN_REVOCATION_CASES[0])}\n${revocationCase(MEMBER_RUN_REVOCATION_CASES[1], "test.skip")}`,
  // Both cases inside a skipped suite.
  `${SELF_TEST_BUN_TEST}describe.skipIf(true)("s", () => {\n${MEMBER_RUN_REVOCATION_CASES.map((title) => revocationCase(title)).join("\n")}\n});`,
  // A local function named test, not bun:test.
  `const test = (..._args: unknown[]) => undefined;\n${MEMBER_RUN_REVOCATION_CASES.map((title) => revocationCase(title)).join("\n")}`,
];

const selfTest = (): number => {
  const failures: string[] = [];
  const files: Record<string, string> = {
    "on-actor.ts": SELF_TEST_ACTOR,
    "pinned.ts": "createRootScopedDb({});",
    "executor.ts": "createRootSafeDb({});",
    "org.ts": "",
    "stray.ts": "",
    "on-actor.integration.test.ts": SELF_TEST_REVOCATION,
    "half.integration.test.ts": `${SELF_TEST_BUN_TEST}${revocationCase(MEMBER_RUN_REVOCATION_CASES[0])}`,
  };
  const entry = (
    authority: QueueAuthorityEntry["authority"],
    worker: string,
    extra: Partial<QueueAuthorityEntry> = {},
  ): QueueAuthorityEntry => ({ authority, worker, reason: "r", ...extra });
  const audit = auditQueueAuthority({
    hostQueues: ["actor", "pinned", "org", "half", "unclassified"],
    registry: {
      actor: entry("member-run", "on-actor.ts", {
        revocationTest: "on-actor.integration.test.ts",
      }),
      pinned: entry("member-run", "pinned.ts", { executors: ["executor.ts"] }),
      org: entry("org-automation", "org.ts"),
      half: entry("member-run", "on-actor.ts", {
        revocationTest: "half.integration.test.ts",
      }),
      ghost: entry("org-automation", "org.ts", { reason: " " }),
    },
    memberRunQueues: [
      { queue: "actor", module: "on-actor.ts" },
      { queue: "half", module: "on-actor.ts" },
      { queue: "org", module: "org.ts" },
    ],
    workerQueues: new Map([
      ["on-actor.ts", ["actor", "half"]],
      ["pinned.ts", ["pinned"]],
      ["org.ts", ["ghost", "org"]],
      ["stray.ts", ["stray"]],
    ]),
    pinnedAllowed: new Set(["executor.ts", "pinned.ts"]),
    readFile: (file) => files[file] ?? null,
  });
  const expectedErrors = [
    "Queue without an authority row: unclassified",
    "Authority row for a queue the host table lacks: ghost",
    "Authority row without a reason: ghost",
    "BullMQ Worker outside the queue authority registry: stray.ts (stray)",
    "MEMBER_RUN_QUEUES lists org (org.ts), but the registry does not classify it as a member run of that module",
  ];
  const expectedMembers = [
    "half::revocation-test",
    "pinned::pinned-handles::executor.ts",
    "pinned::pinned-handles::pinned.ts",
    "pinned::revocation-test",
    "pinned::run-actor",
  ];
  if (JSON.stringify(audit.errors) !== JSON.stringify(expectedErrors)) {
    failures.push(
      `errors must be exactly ${JSON.stringify(expectedErrors)}; got ${JSON.stringify(audit.errors)}`,
    );
  }
  const memberKeys = audit.members.map(({ key }) => key);
  if (JSON.stringify(memberKeys) !== JSON.stringify(expectedMembers)) {
    failures.push(
      `members must be exactly ${JSON.stringify(expectedMembers)}; got ${JSON.stringify(memberKeys)}`,
    );
  }
  const declaredMissing = auditQueueAuthority({
    hostQueues: ["q"],
    registry: { q: entry("org-automation", "missing.ts") },
    memberRunQueues: [],
    workerQueues: new Map(),
    pinnedAllowed: new Set(),
    readFile: () => null,
  });
  if (declaredMissing.errors.length !== 1) {
    failures.push("a declared worker that constructs no Worker must fail");
  }
  // Two rows pointing at each other's modules: module membership is
  // unchanged, so only the queue-to-worker pairs reveal the swap.
  const swapped = auditQueueAuthority({
    hostQueues: ["member", "org"],
    registry: {
      member: entry("member-run", "org.ts"),
      org: entry("org-automation", "member.ts"),
    },
    memberRunQueues: [],
    workerQueues: new Map([
      [
        "member.ts",
        workerQueueNames("member.ts", workerOn("member"), () => null) ?? null,
      ],
      [
        "org.ts",
        workerQueueNames("org.ts", workerOn("org"), () => null) ?? null,
      ],
    ]),
    pinnedAllowed: new Set(),
    readFile: () => null,
  });
  const expectedSwap = [
    "Declared worker module has no Worker on its queue: member -> org.ts",
    "Declared worker module has no Worker on its queue: org -> member.ts",
    "BullMQ Worker on member in member.ts, but the registry assigns it to org.ts",
    "BullMQ Worker on org in org.ts, but the registry assigns it to member.ts",
  ];
  if (JSON.stringify(swapped.errors) !== JSON.stringify(expectedSwap)) {
    failures.push(
      `swapped worker rows must fail as ${JSON.stringify(expectedSwap)}; got ${JSON.stringify(swapped.errors)}`,
    );
  }
  const resolved = workerQueueNames(
    "apps/api/src/lib/w.ts",
    SELF_TEST_WORKER,
    (file) => (file === "apps/api/src/lib/names.ts" ? SELF_TEST_NAMES : null),
  );
  if (
    JSON.stringify(resolved) !==
    JSON.stringify(["imported-a", "imported-b", "local"])
  ) {
    failures.push(
      `aliased Worker queue names must resolve through constants and imports; got ${JSON.stringify(resolved)}`,
    );
  }
  if (
    workerQueueNames("w.ts", SELF_TEST_WEB_WORKER, () => null) !== undefined
  ) {
    failures.push("a web Worker must not count as a BullMQ worker");
  }
  if (workerQueueNames("w.ts", SELF_TEST_DYNAMIC_WORKER, () => null) !== null) {
    failures.push("a Worker on a runtime queue name must not resolve");
  }
  const unresolved = auditQueueAuthority({
    hostQueues: [],
    registry: {},
    memberRunQueues: [],
    workerQueues: new Map([["dynamic.ts", null]]),
    pinnedAllowed: new Set(),
    readFile: () => null,
  });
  if (unresolved.errors.length !== 1) {
    failures.push("an unresolved Worker queue name must fail");
  }
  if (!callsRunActor(SELF_TEST_ACTOR)) {
    failures.push("an aliased run actor call must count");
  }
  if (callsRunActor(SELF_TEST_ACTOR_TEXT_ONLY)) {
    failures.push(
      "run actor text in comments, strings or a local function must not count",
    );
  }
  for (const [index, source] of SELF_TEST_INACTIVE_REVOCATIONS.entries()) {
    const gap = revocationGap(
      entry("member-run", "w.ts", { revocationTest: "r.integration.test.ts" }),
      () => source,
    );
    if (gap === null) {
      failures.push(`inactive revocation case ${String(index)} must not count`);
    }
  }
  if (
    revocationGap(
      entry("member-run", "w.ts", { revocationTest: "r.test.ts" }),
      () => SELF_TEST_REVOCATION,
    ) === null
  ) {
    failures.push(
      "a revocation test outside *.integration.test.ts must not count",
    );
  }
  const keys = objectKeys(
    `const T = { "a-b": "api", c: "x" } as const satisfies Record<string, string>;`,
    "T",
  );
  if (JSON.stringify(keys) !== JSON.stringify(["a-b", "c"])) {
    failures.push(`host table keys must be read; got ${JSON.stringify(keys)}`);
  }
  const difference = baselineDifference(["a", "b"], ["b", "c"]);
  if (
    JSON.stringify(difference) !==
    JSON.stringify({ added: ["a"], stale: ["c"] })
  ) {
    failures.push("a new and a stale baseline row must both be reported");
  }
  if (addedEntries(["x::run-actor"], ["y::run-actor"]).length !== 1) {
    failures.push("a row the base does not list must count as new");
  }
  for (const failure of failures) {
    console.error(`queue-authority --self-test: ${failure}`);
  }
  if (failures.length === 0) {
    console.log("queue-authority --self-test: PASS");
  }
  return failures.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest());
  }
  if (args.includes("--write")) {
    process.exit(write());
  }
  process.exit(check(args.filter((arg) => arg !== "--check")));
}
