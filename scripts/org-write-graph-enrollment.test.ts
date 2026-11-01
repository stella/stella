import { describe, expect, test } from "bun:test";

import { deriveOrgWriteGraphInputs } from "./org-write-graph-enrollment.ts";

const registryFile = "apps/api/src/db/org-scope-registry.ts";
const bookkeepingFile = "apps/api/src/lib/db/recovery-bookkeeping/scheduler.ts";
const authorityFile = "apps/api/src/lib/scheduler/task-authority.ts";
const globalFile = "apps/api/src/lib/db/global-system-work.ts";
const tableRelationsFile = "apps/api/src/lib/db/table-relations.gen.ts";
const descriptor = `schedulerJobs: {
  table: schedulerJobs,
  ownership: "mixed",
  reason: "Organization configuration shares a scheduler with platform lifecycle.",
  writeOwner: {
    type: "scheduler",
    bookkeeping: "${bookkeepingFile}",
    authority: "${authorityFile}",
    global: "${globalFile}",
  },
}`;
const registry = `export const ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}};
  export const GLOBAL_SCOPE_TABLES = {${descriptor}};`;
const bookkeeping = `
  import {schedulerJobs} from "@/api/db/schema";
  type Operation = {table: typeof schedulerJobs} & ({type: "upsert"} | {type: "delete-source"} | {type: "platform-state"});
  export const SCHEDULER_WRITE_INTENT_DISPOSITIONS = {
    upsert: "by-task", "delete-source": "organization", "platform-state": "platform",
  } as const satisfies Record<Operation["type"], "organization" | "platform" | "by-task">;
  export function writeSchedulerBookkeeping(operation: Operation) { return operation; }
`;
const authority = `export const SCHEDULER_TASK_AUTHORITY = {
  "flow.run": {schedulerOwnership: "organization"},
  "scheduler.noop": {schedulerOwnership: "platform"},
};`;
const global = `export const GLOBAL_SYSTEM_JOBS = {
  "flow-schedule-orphan-page": {owner: "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts"},
};`;
const tableRelations = `export const TABLE_RELATIONS = {
  flowRuns: "flow_runs",
  schedulerJobs: "scheduler_jobs",
} as const;`;
const head = (headRegistry: string) => ({
  registry: headRegistry,
  tableRelations,
});
const ownership = new Map([
  [
    "scripts/ownership/root-door.ts",
    'export default {group: "root-connection", id: "root", owner: ["apps/api/src/lib/door.ts"]};',
  ],
  [
    "scripts/ownership/recovery-bookkeeping.ts",
    `const CLASSES = ["scheduler"] as const; export default {id: "recovery-bookkeeping", owner: CLASSES.map((kind) => \`apps/api/src/lib/db/recovery-bookkeeping/\${kind}.ts\`)};`,
  ],
]);
const sources = () =>
  new Map([
    [registryFile, registry],
    [bookkeepingFile, bookkeeping],
    [authorityFile, authority],
    [globalFile, global],
    [tableRelationsFile, tableRelations],
  ]);
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

describe("mixed scheduler graph enrollment", () => {
  test("HEAD derives its table and native intent maps from declared source owners", () => {
    const result = deriveOrgWriteGraphInputs(sources(), ownership, {
      role: "head",
    });
    expect(result.globalTables.has("schedulerJobs")).toBe(true);
    expect(result.orgTables.has("schedulerJobs")).toBe(false);
    expect(result.schedulerWriteIntents).toEqual({
      table: "schedulerJobs",
      ownerFile: bookkeepingFile,
      globalOwnerFile: globalFile,
      dispositions: new Map([
        ["upsert", "by-task"],
        ["delete-source", "organization"],
        ["platform-state", "platform"],
      ]),
      taskOwnership: new Map([
        ["flow.run", "organization"],
        ["scheduler.noop", "platform"],
      ]),
      globalJobs: new Map([
        [
          "flow-schedule-orphan-page",
          "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
        ],
      ]),
    });
  });

  test("source-defined native maps change with each measured tree", () => {
    const changed = sources();
    changed.set(
      authorityFile,
      replaceFixture({
        source: authority,
        from: '"scheduler.noop": {schedulerOwnership: "platform"}',
        to: '"scheduler.noop": {schedulerOwnership: "organization"}',
      }),
    );
    expect(
      deriveOrgWriteGraphInputs(changed, ownership, {
        role: "head",
      }).schedulerWriteIntents?.taskOwnership.get("scheduler.noop"),
    ).toBe("organization");
    expect(
      deriveOrgWriteGraphInputs(sources(), ownership, {
        role: "head",
      }).schedulerWriteIntents?.taskOwnership.get("scheduler.noop"),
    ).toBe("platform");
  });

  test("historical BASE with no bookkeeping module retains mixed constraint and no native grants", () => {
    const historical = new Map([[tableRelationsFile, tableRelations]]);
    const rootOwnership = new Map(
      [...ownership].filter(
        ([file]) => file !== "scripts/ownership/recovery-bookkeeping.ts",
      ),
    );
    const result = deriveOrgWriteGraphInputs(historical, rootOwnership, {
      role: "base",
      head: head(registry),
    });
    expect(result.schedulerWriteIntents).toEqual({
      table: "schedulerJobs",
      ownerFile: bookkeepingFile,
      globalOwnerFile: globalFile,
      dispositions: new Map(),
      taskOwnership: new Map(),
      globalJobs: new Map(),
    });
    expect(result.globalTables.has("schedulerJobs")).toBe(true);
  });

  test("historical owner types still validate the table but cannot grant native authority without intent metadata", () => {
    const historical = sources();
    historical.set(
      bookkeepingFile,
      'import type {schedulerJobs as Jobs} from "@/api/db/schema"; type Operation = {table: typeof Jobs} & {type: "upsert"}; export function writeSchedulerBookkeeping(operation: Operation) {return operation;}',
    );
    historical.delete(authorityFile);
    historical.delete(globalFile);
    const contract = deriveOrgWriteGraphInputs(historical, ownership, {
      role: "base",
      head: head(registry),
    }).schedulerWriteIntents;
    expect(contract?.table).toBe("schedulerJobs");
    expect(contract?.dispositions.size).toBe(0);
    expect(contract?.taskOwnership.size).toBe(0);
    expect(contract?.globalJobs.size).toBe(0);
  });

  test("BASE with actual intent metadata parses its measured declarations strictly", () => {
    expect(
      deriveOrgWriteGraphInputs(sources(), ownership, {
        role: "base",
        head: head(registry),
      }).schedulerWriteIntents?.dispositions.get("upsert"),
    ).toBe("by-task");
    const malformed = sources();
    malformed.set(
      bookkeepingFile,
      replaceFixture({
        source: bookkeeping,
        from: 'upsert: "by-task",',
        to: "",
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(malformed, ownership, {
        role: "base",
        head: head(registry),
      }),
    ).toThrow(/missing intent disposition upsert/iu);
  });

  test.each([
    "export const ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}}; export const GLOBAL_SCOPE_TABLES = {};",
    'export const ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}}; export const GLOBAL_SCOPE_TABLES = {schedulerJobs: {table: schedulerJobs, ownership: "system", reason: "system"}};',
    "export const ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}}; export const GLOBAL_SCOPE_TABLES = {schedulerJobs: {table: schedulerJobs}};",
  ])(
    "a typed scheduler intent owner cannot lose inverse mixed enrollment: %s",
    (changedRegistry) => {
      const measured = sources();
      measured.set(registryFile, changedRegistry);
      expect(() =>
        deriveOrgWriteGraphInputs(measured, ownership, { role: "head" }),
      ).toThrow(/Typed scheduler intent owner requires a matching mixed/iu);
      expect(() =>
        deriveOrgWriteGraphInputs(measured, ownership, {
          role: "base",
          head: head(changedRegistry),
        }),
      ).toThrow(/Typed scheduler intent owner requires a matching mixed/iu);
    },
  );

  test("fixtures without a typed scheduler intent owner keep their existing metadata-less global tables", () => {
    const plain = new Map([
      [tableRelationsFile, tableRelations],
      [
        registryFile,
        "export const ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}}; export const GLOBAL_SCOPE_TABLES = {schedulerJobs: {table: schedulerJobs}};",
      ],
    ]);
    const result = deriveOrgWriteGraphInputs(plain, ownership, {
      role: "head",
    });
    expect(result.schedulerWriteIntents).toBeUndefined();
    expect(result.globalTables).toEqual(new Set(["schedulerJobs"]));
  });

  test.each([bookkeepingFile, authorityFile, globalFile])(
    "HEAD requires the declared source owner %s",
    (file) => {
      const measured = sources();
      measured.delete(file);
      expect(() =>
        deriveOrgWriteGraphInputs(measured, ownership, { role: "head" }),
      ).toThrow(/Missing mixed scheduler source/iu);
      if (file !== bookkeepingFile) {
        expect(() =>
          deriveOrgWriteGraphInputs(measured, ownership, {
            role: "base",
            head: head(registry),
          }),
        ).toThrow(/Missing mixed scheduler source/iu);
      }
    },
  );

  test.each([
    ['type: "scheduler"', 'type: "other"', /unlisted writeOwner type/iu],
    [
      'ownership: "mixed"',
      'ownership: "future"',
      /unknown ownership or misplaced writeOwner/iu,
    ],
    [`bookkeeping: "${bookkeepingFile}",`, "", /missing or unknown fields/iu],
    [
      `bookkeeping: "${bookkeepingFile}"`,
      'bookkeeping: "apps/api/src/lib/unrelated.ts"',
      /unknown bookkeeping owner path/iu,
    ],
    [
      `authority: "${authorityFile}"`,
      'authority: "apps/api/src/lib/unrelated.ts"',
      /unknown authority owner path/iu,
    ],
    [
      `global: "${globalFile}"`,
      'global: "apps/api/src/lib/unrelated.ts"',
      /unknown global owner path/iu,
    ],
    [
      "table: schedulerJobs",
      "table: flowRuns",
      /match its descriptor.table export/iu,
    ],
    [
      'type: "scheduler",',
      'type: "scheduler", extra: "not-enrolled",',
      /missing or unknown fields/iu,
    ],
    [
      'type: "scheduler",',
      'type: "scheduler", type: "scheduler",',
      /unknown or duplicate field/iu,
    ],
    [
      'type: "scheduler",',
      '...metadata, type: "scheduler",',
      /explicit literal fields/iu,
    ],
    ['ownership: "mixed",', "", /unknown ownership or misplaced writeOwner/iu],
  ])(
    "mixed metadata rejects unsupported or ambiguous declaration shapes: %s",
    (from, to, error) => {
      const measured = sources();
      measured.set(
        registryFile,
        replaceFixture({ source: registry, from, to }),
      );
      expect(() =>
        deriveOrgWriteGraphInputs(measured, ownership, { role: "head" }),
      ).toThrow(error);
    },
  );

  test("mixed declarations require their owner block and exclusive physical global registration", () => {
    const missing = sources();
    missing.set(
      registryFile,
      replaceFixture({
        source: registry,
        from: descriptor,
        to: 'schedulerJobs: {table: schedulerJobs, ownership: "mixed", reason: "mixed"}',
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(missing, ownership, { role: "head" }),
    ).toThrow(/missing or unknown fields/iu);
    const overlap = sources();
    overlap.set(
      registryFile,
      replaceFixture({
        source: registry,
        from: "ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}}",
        to: "ORG_SCOPE_TABLES = {flowRuns: {table: flowRuns}, schedulerJobs: {table: schedulerJobs}}",
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(overlap, ownership, { role: "head" }),
    ).toThrow(/registered exclusively in GLOBAL_SCOPE_TABLES/iu);
  });

  test("multiple mixed scheduler descriptors cannot create additional native owners", () => {
    const changed = replaceFixture({
      source: registry,
      from: descriptor,
      to: `${descriptor}, duplicateJobs: ${descriptor
        .slice(descriptor.indexOf("{"))
        .replace("table: schedulerJobs", "table: duplicateJobs")}`,
    });
    const measured = sources();
    measured.set(registryFile, changed);
    expect(() =>
      deriveOrgWriteGraphInputs(measured, ownership, { role: "head" }),
    ).toThrow(/Only one mixed scheduler descriptor/iu);
  });

  test("unregistered and inconsistent table exports cannot become mixed targets", () => {
    const measured = sources();
    measured.set(
      tableRelationsFile,
      replaceFixture({
        source: tableRelations,
        from: '  schedulerJobs: "scheduler_jobs",\n',
        to: "",
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(measured, ownership, { role: "head" }),
    ).toThrow(/Classified table schedulerJobs has no entry/iu);
    const mismatch = sources();
    mismatch.set(
      bookkeepingFile,
      replaceFixture({
        source: bookkeeping,
        from: "import {schedulerJobs}",
        to: "import {otherTable as schedulerJobs}",
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(mismatch, ownership, { role: "head" }),
    ).toThrow(/matching mixed GLOBAL_SCOPE_TABLES descriptor/iu);
  });

  test("malformed present future metadata is never reclassified as legacy absence", () => {
    const measured = sources();
    measured.set(
      bookkeepingFile,
      replaceFixture({
        source: bookkeeping,
        from: "export const SCHEDULER_WRITE_INTENT_DISPOSITIONS",
        to: "const SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      }),
    );
    expect(() =>
      deriveOrgWriteGraphInputs(measured, ownership, {
        role: "base",
        head: head(registry),
      }),
    ).toThrow(/direct exported SCHEDULER_WRITE_INTENT_DISPOSITIONS/iu);
    const missing = sources();
    missing.set(
      bookkeepingFile,
      'import {schedulerJobs} from "@/api/db/schema"; type Operation={table: typeof schedulerJobs}; export function writeSchedulerBookkeeping(operation: Operation) {return operation;}',
    );
    expect(() =>
      deriveOrgWriteGraphInputs(missing, ownership, { role: "head" }),
    ).toThrow(/HEAD mixed scheduler owner is missing/iu);
  });

  test("unexported destructured intent bindings cannot silently become historical absence", () => {
    const measured = sources();
    measured.set(
      bookkeepingFile,
      'import {schedulerJobs} from "@/api/db/schema"; type Operation={table: typeof schedulerJobs}; const {SCHEDULER_WRITE_INTENT_DISPOSITIONS}=externalMap; export function writeSchedulerBookkeeping(operation: Operation) {return operation;}',
    );
    expect(() =>
      deriveOrgWriteGraphInputs(measured, ownership, {
        role: "base",
        head: head(registry),
      }),
    ).toThrow(/direct exported SCHEDULER_WRITE_INTENT_DISPOSITIONS/iu);
  });

  test("malformed authority and global maps remain source errors for HEAD and typed BASE", () => {
    for (const role of ["head", "base"] as const) {
      const badAuthority = sources();
      badAuthority.set(
        authorityFile,
        "export const SCHEDULER_TASK_AUTHORITY={task: {}};",
      );
      expect(() =>
        deriveOrgWriteGraphInputs(badAuthority, ownership, {
          role,
          head: head(registry),
        }),
      ).toThrow(/missing schedulerOwnership/iu);
      const badGlobal = sources();
      badGlobal.set(
        globalFile,
        "export const GLOBAL_SYSTEM_JOBS={job: {owner: ownerFile}};",
      );
      expect(() =>
        deriveOrgWriteGraphInputs(badGlobal, ownership, {
          role,
          head: head(registry),
        }),
      ).toThrow(/must be a string literal/iu);
    }
  });
});
