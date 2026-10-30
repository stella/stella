import { describe, expect, test } from "bun:test";

import {
  parseSchedulerTaskOwnership,
  parseSchedulerWriteIntentDispositions,
  parseSchedulerWriteTable,
} from "./scheduler-write-intent-contract";

const authoritySource = `
  const TASKS = "apps/api/src/lib/scheduler/tasks";
  const platform = (module: string, reason: string) => ({
    schedulerOwnership: "platform",
    authority: "org-automation",
    module: \`\${TASKS}/\${module}\`,
    reason,
  }) as const satisfies SchedulerTaskAuthorityEntry;
  export const SCHEDULER_TASK_AUTHORITY = {
    "flow.run": {
      schedulerOwnership: "organization",
      authority: "member-run",
      module: \`\${TASKS}/flow-run.ts\`,
      runActor: {module: "start-run.ts", resolver: "resolveMemberAuthorization"},
      reason: "Starts the organization's scheduled run.",
    },
    "scheduler.noop": {
      schedulerOwnership: "platform",
      authority: "org-automation",
      module: "registry.ts",
      reason: "No-op task.",
    },
    "flows.recoverUploadTriggers": platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts."),
  } as const satisfies SchedulerTaskAuthorityRegistry;
`;

const intentSource = `
  type SchedulerBookkeepingOperation = {table: unknown} & (
    | {type: "upsert"; ownership: "platform"; db: unknown}
    | {type: "upsert"; ownership: "organization"; db: unknown}
    | {type: "delete-source"; db: unknown; jobId: string}
    | {type: "checkpoint-slot"; db: unknown; jobId: string}
    | {type: "platform-state"; db: unknown}
  );
  export const SCHEDULER_WRITE_INTENT_DISPOSITIONS = {
    upsert: "by-task",
    "delete-source": "organization",
    "checkpoint-slot": "organization",
    "platform-state": "platform",
  } as const satisfies Record<SchedulerBookkeepingOperation["type"], "organization" | "platform" | "by-task">;
  export function writeSchedulerBookkeeping(operation: {type: "checkpoint-slot"}): Promise<{id: string}[]>;
  export function writeSchedulerBookkeeping(operation: SchedulerBookkeepingOperation): Promise<void>;
  export async function writeSchedulerBookkeeping(operation: SchedulerBookkeepingOperation) {
    return operation;
  }
`;

const replaceFixture = ({
  source,
  from,
  to,
}: {
  source: string;
  from: string;
  to: string;
}) => {
  expect(source).toContain(from);
  const changed = source.replace(from, () => to);
  expect(changed).not.toBe(source);
  return changed;
};

describe("scheduler task ownership source contract", () => {
  test("reads inline and verified helper ownership without evaluating runtime imports", () => {
    expect([...parseSchedulerTaskOwnership(authoritySource)]).toEqual([
      ["flow.run", "organization"],
      ["scheduler.noop", "platform"],
      ["flows.recoverUploadTriggers", "platform"],
    ]);
  });

  test("base and head declarations are measured from their own source", () => {
    const changed = replaceFixture({
      source: authoritySource,
      from: 'schedulerOwnership: "organization"',
      to: 'schedulerOwnership: "platform"',
    });
    expect(parseSchedulerTaskOwnership(authoritySource).get("flow.run")).toBe(
      "organization",
    );
    expect(parseSchedulerTaskOwnership(changed).get("flow.run")).toBe(
      "platform",
    );
  });

  test("a single-return platform block keeps its literal ownership proof", () => {
    const changed = replaceFixture({
      source: authoritySource,
      from: `const platform = (module: string, reason: string) => ({\n    schedulerOwnership: "platform",\n    authority: "org-automation",\n    module: \`\${TASKS}/\${module}\`,\n    reason,\n  }) as const satisfies SchedulerTaskAuthorityEntry;`,
      to: 'const platform = (module: string, reason: string) => { return {schedulerOwnership: "platform", module, reason}; };',
    });
    expect(
      parseSchedulerTaskOwnership(changed).get("flows.recoverUploadTriggers"),
    ).toBe("platform");
  });

  test("all-inline registries do not require an unused platform helper", () => {
    expect([
      ...parseSchedulerTaskOwnership(
        `export const SCHEDULER_TASK_AUTHORITY = {task: {schedulerOwnership: "platform"}};`,
      ),
    ]).toEqual([["task", "platform"]]);
  });

  test.each([
    ['schedulerOwnership: "organization",', "", /missing schedulerOwnership/iu],
    [
      'schedulerOwnership: "organization",',
      'schedulerOwnership: "system",',
      /ownership literal/iu,
    ],
    [
      'schedulerOwnership: "organization",',
      "schedulerOwnership: selectedOwnership,",
      /ownership literal/iu,
    ],
    [
      'schedulerOwnership: "organization",',
      'schedulerOwnership: "organization", schedulerOwnership: "platform",',
      /duplicate field schedulerOwnership/iu,
    ],
    [
      'schedulerOwnership: "organization",',
      '...{schedulerOwnership: "organization"},',
      /unsupported property or spread/iu,
    ],
    [
      'schedulerOwnership: "organization",',
      'get schedulerOwnership() { return "organization"; },',
      /unsupported property or spread/iu,
    ],
    [
      'schedulerOwnership: "organization",',
      '["schedulerOwnership"]: "organization",',
      /unsupported property or spread/iu,
    ],
    ['"scheduler.noop": {', '"flow.run": {', /duplicate field flow.run/iu],
    [
      'platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      'other("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      /canonical platform call/iu,
    ],
    [
      'platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      'helpers.platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      /canonical platform call/iu,
    ],
    [
      'platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      "platform(...args)",
      /canonical platform call/iu,
    ],
    [
      'platform("upload-flow-trigger-recovery.ts", "Replays admitted receipts.")',
      'platform(sourceModule, "Replays admitted receipts.")',
      /canonical platform call/iu,
    ],
    ["const platform =", "let platform =", /local const helper/iu],
    [
      "const platform =",
      "const otherPlatform =",
      /missing unique local platform helper/iu,
    ],
    [
      "(module: string, reason: string) => ({",
      "async (module: string, reason: string) => ({",
      /unsupported platform helper form/iu,
    ],
    [
      'schedulerOwnership: "platform",',
      'schedulerOwnership: "organization",',
      /literal platform ownership/iu,
    ],
    ['schedulerOwnership: "platform",', "", /missing schedulerOwnership/iu],
    [
      'schedulerOwnership: "platform",',
      'schedulerOwnership: "platform", schedulerOwnership: "organization",',
      /duplicate field schedulerOwnership/iu,
    ],
    [
      'schedulerOwnership: "platform",',
      '...options, schedulerOwnership: "platform",',
      /unsupported property or spread/iu,
    ],
    [
      "export const SCHEDULER_TASK_AUTHORITY",
      "const SCHEDULER_TASK_AUTHORITY",
      /direct exported SCHEDULER_TASK_AUTHORITY/iu,
    ],
    [
      "export const SCHEDULER_TASK_AUTHORITY",
      "export let SCHEDULER_TASK_AUTHORITY",
      /initialized exported const/iu,
    ],
  ])(
    "rejects missing, ambiguous, or unverified ownership: %s",
    (from, to, error) => {
      const changed = replaceFixture({ source: authoritySource, from, to });
      expect(() => parseSchedulerTaskOwnership(changed)).toThrow(error);
    },
  );

  test.each([
    "export const SCHEDULER_TASK_AUTHORITY = {};",
    "export const SCHEDULER_TASK_AUTHORITY = externalRegistry;",
  ])(
    "empty or opaque registries cannot count as complete ownership: %s",
    (source) => {
      expect(() => parseSchedulerTaskOwnership(source)).toThrow(
        /must not be empty|literal object/iu,
      );
    },
  );

  test("a platform helper with effects or alternate returns lacks a literal return proof", () => {
    const source = `
      const platform = (module, reason) => { observe(); return {schedulerOwnership: "platform", module, reason}; };
      export const SCHEDULER_TASK_AUTHORITY = {task: platform("task.ts", "reason")};
    `;
    expect(() => parseSchedulerTaskOwnership(source)).toThrow(
      /directly return its literal object/iu,
    );
  });

  test("invalid syntax is never accepted as an empty source registry", () => {
    expect(() =>
      parseSchedulerTaskOwnership("export const SCHEDULER_TASK_AUTHORITY = {"),
    ).toThrow(/does not parse/iu);
  });
});

describe("scheduler write intent source contract", () => {
  test("derives complete operation keys through intersections and repeated discriminator branches", () => {
    expect([...parseSchedulerWriteIntentDispositions(intentSource)]).toEqual([
      ["upsert", "by-task"],
      ["delete-source", "organization"],
      ["checkpoint-slot", "organization"],
      ["platform-state", "platform"],
    ]);
  });

  test("local operation and disposition aliases retain their exact source meaning", () => {
    const source = `
      type Common = {db: unknown};
      type UpsertType = "upsert";
      type UpsertOperation = {type: UpsertType; values: unknown};
      type Intent = "organization" | "platform" | "by-task";
      type Operation = Common & (UpsertOperation | {type: "remove"});
      export const SCHEDULER_WRITE_INTENT_DISPOSITIONS = {upsert: "by-task", remove: "organization"} as const satisfies Record<Operation["type"], Intent>;
      export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
    `;
    expect([...parseSchedulerWriteIntentDispositions(source)]).toEqual([
      ["upsert", "by-task"],
      ["remove", "organization"],
    ]);
  });

  test("new operation types require an explicit disposition in the same measured source", () => {
    const source = replaceFixture({
      source: intentSource,
      from: '| {type: "platform-state"; db: unknown}',
      to: '| {type: "platform-state"; db: unknown} | {type: "new-operation"; db: unknown}',
    });
    expect(() => parseSchedulerWriteIntentDispositions(source)).toThrow(
      /missing intent disposition new-operation/iu,
    );
    const complete = replaceFixture({
      source,
      from: '"platform-state": "platform",',
      to: '"platform-state": "platform", "new-operation": "platform",',
    });
    expect(
      parseSchedulerWriteIntentDispositions(complete).get("new-operation"),
    ).toBe("platform");
    expect(
      parseSchedulerWriteIntentDispositions(intentSource).has("new-operation"),
    ).toBe(false);
  });

  test.each([
    ['upsert: "by-task",', "", /missing intent disposition upsert/iu],
    [
      '"delete-source": "organization",',
      "",
      /missing intent disposition delete-source/iu,
    ],
    [
      '"checkpoint-slot": "organization",',
      "",
      /missing intent disposition checkpoint-slot/iu,
    ],
    [
      '"platform-state": "platform",',
      "",
      /missing intent disposition platform-state/iu,
    ],
    [
      'upsert: "by-task",',
      'upsert: "by-task", unknown: "platform",',
      /unexpected intent disposition unknown/iu,
    ],
    [
      'upsert: "by-task",',
      'upsert: "by-task", upsert: "platform",',
      /duplicate field upsert/iu,
    ],
    ['upsert: "by-task",', 'upsert: "ignore",', /literal intent disposition/iu],
    [
      'upsert: "by-task",',
      "upsert: selectedIntent,",
      /literal intent disposition/iu,
    ],
    [
      'upsert: "by-task",',
      '...{upsert: "by-task"},',
      /unsupported property or spread/iu,
    ],
    [
      'upsert: "by-task",',
      'get upsert() { return "by-task"; },',
      /unsupported property or spread/iu,
    ],
    [
      "as const satisfies Record",
      "satisfies Record",
      /as const literal declaration/iu,
    ],
    [
      'as const satisfies Record<SchedulerBookkeepingOperation["type"], "organization" | "platform" | "by-task">',
      "as const",
      /as const satisfies Record/iu,
    ],
    [
      "Record<SchedulerBookkeepingOperation",
      "Partial<SchedulerBookkeepingOperation",
      /global total Record/iu,
    ],
    [
      'SchedulerBookkeepingOperation["type"]',
      'SchedulerBookkeepingOperation["ownership"]',
      /keys must derive/iu,
    ],
    [
      '"organization" | "platform" | "by-task">',
      '"organization" | "platform">',
      /disposition type must be/iu,
    ],
    [
      '"organization" | "platform" | "by-task">',
      "string>",
      /string literals/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown; jobId: string}',
      "| {db: unknown; jobId: string}",
      /every operation branch must declare/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown; jobId: string}',
      '| {type?: "delete-source"; db: unknown; jobId: string}',
      /mandatory type discriminator/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown; jobId: string}',
      "| {type: string; db: unknown; jobId: string}",
      /string literals/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown; jobId: string}',
      "| ImportedOperation",
      /unresolved local operation type alias ImportedOperation/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown; jobId: string}',
      '| {type: "delete-source"; type: "checkpoint-slot"; db: unknown}',
      /unknown or duplicate field/iu,
    ],
    [
      "export const SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      "const SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      /direct exported SCHEDULER_WRITE_INTENT_DISPOSITIONS/iu,
    ],
    [
      "export const SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      "export let SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      /initialized exported const/iu,
    ],
    [
      "export async function writeSchedulerBookkeeping(operation: SchedulerBookkeepingOperation)",
      "export async function writeSchedulerBookkeeping(operation: DifferentOperation)",
      /concrete writer.s operation type/iu,
    ],
    [
      "export async function writeSchedulerBookkeeping(operation: SchedulerBookkeepingOperation)",
      "export async function otherWriter(operation: SchedulerBookkeepingOperation)",
      /unique concrete writeSchedulerBookkeeping/iu,
    ],
  ])(
    "rejects incomplete, ambiguous, or unbound intent metadata: %s",
    (from, to, error) => {
      const changed = replaceFixture({ source: intentSource, from, to });
      expect(() => parseSchedulerWriteIntentDispositions(changed)).toThrow(
        error,
      );
    },
  );

  test("a shadowed Record type cannot weaken the required compile-time totality", () => {
    expect(() =>
      parseSchedulerWriteIntentDispositions(
        `type Record<Key, Value> = unknown;\n${intentSource}`,
      ),
    ).toThrow(/global total Record/iu);
  });

  test("an imported Record alias cannot stand in for the global totality utility", () => {
    expect(() =>
      parseSchedulerWriteIntentDispositions(
        `import type {LooseMap as Record} from "./other";\n${intentSource}`,
      ),
    ).toThrow(/global total Record/iu);
  });

  test.each([
    [
      '| {type: "platform-state"; db: unknown}',
      "| SchedulerBookkeepingOperation",
      /cyclic operation type alias/iu,
    ],
    [
      '"organization" | "platform" | "by-task">',
      "Intent>",
      /cyclic literal type alias/iu,
    ],
  ])(
    "recursive source aliases fail instead of truncating a declaration: %s",
    (from, to, error) => {
      const changed = replaceFixture({ source: intentSource, from, to });
      const prefix =
        to === "Intent>" ? 'type Intent = "organization" | Intent;\n' : "";
      expect(() =>
        parseSchedulerWriteIntentDispositions(prefix + changed),
      ).toThrow(error);
    },
  );

  test("invalid syntax cannot become an empty intent map", () => {
    expect(() =>
      parseSchedulerWriteIntentDispositions(
        "export const SCHEDULER_WRITE_INTENT_DISPOSITIONS = {",
      ),
    ).toThrow(/does not parse/iu);
  });
});

const tableSource = `
  import type {schedulerJobs as JobTable} from "@/api/db/schema";
  type Operation = {table: typeof JobTable} & (
    | {type: "upsert"; db: unknown}
    | {type: "delete-source"; db: unknown}
  );
  export function writeSchedulerBookkeeping(operation: {type: "upsert"}): Promise<void>;
  export function writeSchedulerBookkeeping(operation: Operation): Promise<void>;
  export async function writeSchedulerBookkeeping(operation: Operation) { return operation; }
`;

describe("scheduler common write table source contract", () => {
  test("historical owners derive their canonical schema export without an intents map", () => {
    expect(tableSource).not.toContain("SCHEDULER_WRITE_INTENT_DISPOSITIONS");
    expect(parseSchedulerWriteTable(tableSource)).toBe("schedulerJobs");
  });

  test("value imports and named aliases resolve to the actual schema export", () => {
    const source = replaceFixture({
      source: tableSource,
      from: "import type {schedulerJobs as JobTable}",
      to: "import {schedulerJobs as JobTable}",
    });
    expect(parseSchedulerWriteTable(source)).toBe("schedulerJobs");
    const changed = replaceFixture({
      source,
      from: "import {schedulerJobs as JobTable}",
      to: "import {differentJobs as JobTable}",
    });
    expect(parseSchedulerWriteTable(changed)).toBe("differentJobs");
    expect(parseSchedulerWriteTable(source)).toBe("schedulerJobs");
  });

  test("the concrete writer operation type wins over unrelated similarly named aliases", () => {
    const source = `type SchedulerBookkeepingOperation = {table: unknown};
${tableSource}`;
    expect(parseSchedulerWriteTable(source)).toBe("schedulerJobs");
  });

  test("local common type aliases and identical per-branch aliases preserve the same table", () => {
    const source = `
      import {schedulerJobs as Jobs, schedulerJobs as SameJobs} from "@/api/db/schema";
      type Common = {table: typeof Jobs};
      type Upsert = {type: "upsert"; table: typeof SameJobs};
      type Delete = {type: "delete-source"};
      type Operation = Common & (Upsert | Delete);
      export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
    `;
    expect(parseSchedulerWriteTable(source)).toBe("schedulerJobs");
  });

  test("uniform per-branch target types prove the same common write table", () => {
    const source = `
      import {schedulerJobs as Jobs} from "@/api/db/schema";
      type Operation = {type: "upsert"; table: typeof Jobs} | {type: "delete-source"; table: typeof Jobs};
      export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
    `;
    expect(parseSchedulerWriteTable(source)).toBe("schedulerJobs");
  });

  test.each([
    ["{table: typeof JobTable}", "{}", /common mandatory table/iu],
    [
      "{table: typeof JobTable}",
      "{table?: typeof JobTable}",
      /mandatory table field/iu,
    ],
    [
      "{table: typeof JobTable}",
      "{table: unknown}",
      /requires typeof a named schema import/iu,
    ],
    [
      "{table: typeof JobTable}",
      "{table: typeof JobTable | undefined}",
      /requires typeof a named schema import/iu,
    ],
    [
      "{table: typeof JobTable}",
      "{table: typeof JobTable | typeof OtherJobs}",
      /requires typeof a named schema import/iu,
    ],
    [
      "{table: typeof JobTable}",
      "{table: typeof JobTable; table: typeof JobTable}",
      /unknown or duplicate field/iu,
    ],
    [
      "{table: typeof JobTable}",
      '{["table"]: typeof JobTable}',
      /static property signatures/iu,
    ],
    [
      'import type {schedulerJobs as JobTable} from "@/api/db/schema";',
      "",
      /unclassified or ambiguous schema import/iu,
    ],
    [
      '"@/api/db/schema"',
      '"@/api/db/other"',
      /named canonical schema import/iu,
    ],
    [
      "import type {schedulerJobs as JobTable}",
      "import JobTable",
      /named canonical schema import/iu,
    ],
    [
      "import type {schedulerJobs as JobTable}",
      "import * as JobTable",
      /named canonical schema import/iu,
    ],
    [
      "import type {schedulerJobs as JobTable}",
      "import {default as JobTable}",
      /named canonical schema export/iu,
    ],
    [
      "typeof JobTable",
      "typeof namespace.JobTable",
      /requires typeof a named schema import/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown}',
      "| ImportedOperation",
      /unresolved local operation type alias/iu,
    ],
    [
      '| {type: "delete-source"; db: unknown}',
      "| Operation",
      /cyclic operation type alias/iu,
    ],
    [
      "export async function writeSchedulerBookkeeping(operation: Operation)",
      "export async function differentWriter(operation: Operation)",
      /unique concrete writeSchedulerBookkeeping/iu,
    ],
  ])(
    "missing, wide, opaque, and unclassified table shapes fail closed: %s",
    (from, to, error) => {
      const changed = replaceFixture({ source: tableSource, from, to });
      expect(() => parseSchedulerWriteTable(changed)).toThrow(error);
    },
  );

  test("one missing per-branch table cannot be hidden by another branch", () => {
    const source = `
      import {schedulerJobs as Jobs} from "@/api/db/schema";
      type Operation = {type: "upsert"; table: typeof Jobs} | {type: "delete-source"};
      export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
    `;
    expect(() => parseSchedulerWriteTable(source)).toThrow(
      /common mandatory table/iu,
    );
  });

  test.each([
    '({table: typeof Jobs} & {type: "upsert"; table: typeof Other})',
    '({type: "upsert"; table: typeof Jobs} | {type: "delete-source"; table: typeof Other})',
  ])(
    "different actual imported targets cannot share a mixed-table enrollment: %s",
    (operation) => {
      const source = `
      import {schedulerJobs as Jobs, unrelatedJobs as Other} from "@/api/db/schema";
      type Operation = ${operation};
      export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
    `;
      expect(() => parseSchedulerWriteTable(source)).toThrow(
        /different scheduler write tables/iu,
      );
    },
  );

  test.each([
    "const JobTable = {};",
    "const {value: JobTable} = {value: {}};",
    "function JobTable() { return {}; }",
    "class JobTable {}",
  ])(
    "a local value declaration cannot stand in for an imported schema target: %s",
    (shadow) => {
      const source = `${shadow}
${tableSource}`;
      expect(() => parseSchedulerWriteTable(source)).toThrow(
        /shadowed schema import|does not parse/iu,
      );
    },
  );

  test("a local table-like value without its schema import remains unclassified", () => {
    const source = replaceFixture({
      source: tableSource,
      from: 'import type {schedulerJobs as JobTable} from "@/api/db/schema";',
      to: "const JobTable = {};",
    });
    expect(() => parseSchedulerWriteTable(source)).toThrow(
      /unclassified or ambiguous schema import/iu,
    );
  });

  test("invalid syntax cannot invent a write table", () => {
    expect(() =>
      parseSchedulerWriteTable("export function writeSchedulerBookkeeping("),
    ).toThrow(/does not parse/iu);
  });
});
