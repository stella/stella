// Hold every BullMQ queue to a declared authority and every member-run queue
// to the run actor, with a shrink-only, reasoned baseline
// (scripts/queue-authority-baseline.json).
//
// The registry is `QUEUE_AUTHORITY` in apps/api/src/lib/member-run-queues.ts.
// Its type requires a row per queue in the BullMQ host table; this script
// checks what the type cannot:
//
//   errors   (never baselined) a queue the host table and the registry
//            disagree on; a row without a reason; a declared worker module
//            that does not construct a BullMQ `Worker`; a BullMQ `Worker`
//            constructed in a module no row declares; a `MEMBER_RUN_QUEUES`
//            entry the registry does not classify as a member run of that
//            module.
//   members  (baselined, keyed without line numbers) a member-run queue that
//            does not build its handles with `createRootRunActor`
//            (`<queue>::run-actor`); a member-run module the pinned-handle
//            allowlist still admits (`<queue>::pinned-handles::<file>`); a
//            member-run queue without an integration test of both revocation
//            cases (`<queue>::revocation-test`).
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
const RUN_ACTOR_CALL = "createRootRunActor(";

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
  /** Modules that construct a BullMQ `Worker`. */
  workerModules: readonly string[];
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
  const declaredWorkers = new Set<string>();
  for (const [queue, entry] of Object.entries(input.registry)) {
    if (!hosted.has(queue)) {
      errors.push(`Authority row for a queue the host table lacks: ${queue}`);
    }
    if (entry.reason.trim() === "") {
      errors.push(`Authority row without a reason: ${queue}`);
    }
    declaredWorkers.add(entry.worker);
    if (!input.workerModules.includes(entry.worker)) {
      errors.push(
        `Declared worker module constructs no BullMQ Worker: ${queue} -> ${entry.worker}`,
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
  for (const module of input.workerModules) {
    if (!declaredWorkers.has(module)) {
      errors.push(
        `BullMQ Worker outside the queue authority registry: ${module}`,
      );
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

const revocationGap = (
  entry: QueueAuthorityEntry,
  readFile: AuditInput["readFile"],
): string | null => {
  if (entry.revocationTest === undefined) {
    return REASONS.revocationTest;
  }
  const source = readFile(entry.revocationTest);
  if (source === null) {
    return `revocationTest ${entry.revocationTest} does not exist.`;
  }
  const missing = MEMBER_RUN_REVOCATION_CASES.filter(
    (title) => !source.includes(title),
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
      onActor.has(queue) &&
      (input.readFile(entry.worker) ?? "").includes(RUN_ACTOR_CALL);
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

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isSatisfiesExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;

const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

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

/** Whether `source` constructs the `Worker` it imports from bullmq. */
const constructsBullMqWorker = (source: string): boolean => {
  if (!source.includes("bullmq")) {
    return false;
  }
  const file = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest);
  const local = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "bullmq" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "Worker") {
          local.add(element.name.text);
        }
      }
    }
  }
  if (local.size === 0) {
    return false;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      local.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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
  const workerModules = [
    ...new Bun.Glob(`${API_SOURCE}**/*.ts`).scanSync({ cwd: ROOT }),
  ]
    .filter(isProductionSource)
    .filter((file) => constructsBullMqWorker(readRepoFile(file) ?? ""))
    .toSorted();
  const pinnedRow = OWNERSHIP.find(({ id }) => id === PINNED_HANDLES_ROW);
  if (pinnedRow?.enforcement.kind !== "import") {
    return panic(`ownership row ${PINNED_HANDLES_ROW} is not an import row`);
  }
  return {
    hostQueues,
    registry: QUEUE_AUTHORITY,
    memberRunQueues: MEMBER_RUN_QUEUES,
    workerModules,
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
  export const start = () => new BullWorker<Job>("q", async () => {});
`;
const SELF_TEST_WEB_WORKER = `
  export const start = () => new Worker(new URL("./w.ts", import.meta.url));
`;
const SELF_TEST_REVOCATION = MEMBER_RUN_REVOCATION_CASES.map(
  (title) => `test("${title}", async () => {});`,
).join("\n");

const selfTest = (): number => {
  const failures: string[] = [];
  const files: Record<string, string> = {
    "on-actor.ts": `const actor = ${RUN_ACTOR_CALL}data);`,
    "pinned.ts": "createRootScopedDb({});",
    "executor.ts": "createRootSafeDb({});",
    "org.ts": "",
    "stray.ts": "",
    "on-actor.test.ts": SELF_TEST_REVOCATION,
    "half.test.ts": `test("${MEMBER_RUN_REVOCATION_CASES[0]}", async () => {});`,
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
        revocationTest: "on-actor.test.ts",
      }),
      pinned: entry("member-run", "pinned.ts", { executors: ["executor.ts"] }),
      org: entry("org-automation", "org.ts"),
      half: entry("member-run", "on-actor.ts", {
        revocationTest: "half.test.ts",
      }),
      ghost: entry("org-automation", "org.ts", { reason: " " }),
    },
    memberRunQueues: [
      { queue: "actor", module: "on-actor.ts" },
      { queue: "half", module: "on-actor.ts" },
      { queue: "org", module: "org.ts" },
    ],
    workerModules: ["on-actor.ts", "pinned.ts", "org.ts", "stray.ts"],
    pinnedAllowed: new Set(["executor.ts", "pinned.ts"]),
    readFile: (file) => files[file] ?? null,
  });
  const expectedErrors = [
    "Queue without an authority row: unclassified",
    "Authority row for a queue the host table lacks: ghost",
    "Authority row without a reason: ghost",
    "BullMQ Worker outside the queue authority registry: stray.ts",
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
    workerModules: [],
    pinnedAllowed: new Set(),
    readFile: () => null,
  });
  if (declaredMissing.errors.length !== 1) {
    failures.push("a declared worker that constructs no Worker must fail");
  }
  if (!constructsBullMqWorker(SELF_TEST_WORKER)) {
    failures.push("an aliased BullMQ Worker construction must be found");
  }
  if (constructsBullMqWorker(SELF_TEST_WEB_WORKER)) {
    failures.push("a web Worker must not count as a BullMQ worker");
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
