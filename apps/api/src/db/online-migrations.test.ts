import { SQL } from "bun";
import { describe, expect, expectTypeOf, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";
import { rejectionOf } from "@stll/property-testing/rejection";

import { PROVISION_STATE_BACKFILL_STEPS } from "@/api/lib/case-law/provision-state-backfill/backfill";

import { readOnlineIndexConfig } from "../env-online-index";
import { REWRITTEN_MIGRATION_INDEXES } from "../lib/db/migration-history";
import { ACCOUNT_AUDIT_CONSTRAINT_VALIDATION } from "./account-audit-constraint-validation";
import { BackfillHeldError } from "./backfill-runtime";
import { CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR } from "./corpus-projection-delete-receipt-repair";
import {
  createDecisionDateCeilingRepair,
  DECISION_DATE_CEILING_REPAIR,
} from "./decision-date-ceiling-repair";
import type { MigrationTimingRecord } from "./migration-timing";
import type { OnlineIndexDeclaration } from "./online-ddl";
import { declaresOnlineBuild } from "./online-ddl";
import { createOnlineIndexHold } from "./online-index-gate";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";
import {
  ensureOnlineIndexValid,
  ONLINE_CONSTRAINT_VALIDATIONS,
  ONLINE_INDEX_REPLACEMENTS,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
  type OnlineRepairOptions,
  reportOnlineMigrations as reportOnlineMigrationsWithOwnership,
  runOnlineMigrations as runOnlineMigrationsWithGate,
} from "./online-migrations";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  type ExecutableOnlineUniqueIndexName,
  ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
  onlineUniqueIndexDefinition,
} from "./online-unique-indexes";
import { SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS } from "./sanctions-monitoring-constraint-validation";

const testClock = () => Date.parse("2026-10-01T12:00:00.000Z");
const healthyIndexGate = {
  config: {
    ...readOnlineIndexConfig({}),
    health: { ...defaultConfig, busyWindows: [] },
  },
  clock: testClock,
  ebs: {
    type: "reader",
    read: async () => ({
      indicator: "ebs_balance",
      kind: "normal",
      value: 100,
      threshold: 70,
      observedAt: new Date(testClock()).toISOString(),
      reason: "Injected balance",
    }),
  },
  log: () => undefined,
} satisfies OnlineIndexGateOptions;
const heldIndexGate = {
  ...healthyIndexGate,
  ebs: {
    type: "reader",
    read: async () => ({
      indicator: "ebs_balance",
      kind: "unknown",
      value: null,
      threshold: 70,
      observedAt: null,
      reason: "Injected unavailable metric",
    }),
  },
} satisfies OnlineIndexGateOptions;
const reserveHealthyObserver =
  async (): Promise<OnlineMigrationConnection> => ({
    execute: async () => undefined,
    query: async (query) => {
      if (query.includes("pg_blocking_pids")) {
        return [];
      }
      if (query.includes("pg_backend_pid() AS pid")) {
        return [{ pid: 2, database: "test" }];
      }
      if (query.includes('"stateAgeMs"')) {
        return [];
      }
      if (query.includes("ageMs")) {
        return [{ ageMs: 0, observedAt: new Date(testClock()).toISOString() }];
      }
      return [
        { active: false, observedAt: new Date(testClock()).toISOString() },
      ];
    },
    release: () => undefined,
  });
const runOnlineMigrations = async (
  pool: Parameters<typeof runOnlineMigrationsWithGate>[0],
  options: Partial<OnlineRepairOptions> = {},
) =>
  await runOnlineMigrationsWithGate(pool, {
    indexGate: healthyIndexGate,
    timing: { clock: () => 0, emit: () => undefined },
    ...options,
    reserveObserver: reserveHealthyObserver,
  });

const reportOnlineMigrations = async (
  ...args: Parameters<typeof reportOnlineMigrationsWithOwnership>
) => {
  const outcome = await reportOnlineMigrationsWithOwnership(...args);
  switch (outcome.type) {
    case "validated":
      return outcome.report;
    case "migrator_active":
      throw new TypeError("Expected startup validation ownership");
    default:
      outcome satisfies never;
      throw new TypeError("Unknown validation ownership");
  }
};

const CREATE_INDEX_FRAGMENT = "CREATE INDEX CONCURRENTLY";
const DROP_INDEX_FRAGMENT = "DROP INDEX CONCURRENTLY";
const REINDEX_FRAGMENT = "REINDEX INDEX CONCURRENTLY";
const REPORT_EXPORT_INDEX = "report_exports_workspace_requester_created_idx";
const CREDENTIAL_INDEX = "account_credential_singleton_uidx";
const CHAT_RUN_INDEX = "chat_turns_org_run_id_uidx";
const SOURCE_DOCUMENT_INDEX = "case_law_decisions_source_document_idx";
const SOURCE_CASE_INDEX = "case_law_decisions_source_case_lang_null_idx";
const LEGACY_SOURCE_CASE_INDEX = "case_law_decisions_source_case_lang_idx";
const DOCUMENT_DATE_INDEX = "case_law_decisions_document_outstanding_date_idx";
const LEGACY_DOCUMENT_DATE_INDEX =
  "case_law_decisions_document_pending_date_idx";
const ACCOUNT_INDEX = "account_provider_account_id_uidx";
const LEGACY_ACCOUNT_INDEX = "account_issuer_account_id_uidx";
const FILTER_INDEX_CUTOVER = ONLINE_MIGRATION_INDEX_CUTOVERS.at(0);
if (!FILTER_INDEX_CUTOVER) {
  throw new TypeError("Expected the filter index cutover");
}
const FILTER_INDEX = FILTER_INDEX_CUTOVER.final.name;
const FILTER_INDEX_REPLACEMENT = FILTER_INDEX_CUTOVER.staged.name;
const DECISION_DATE_CONSTRAINT = "case_law_decisions_decision_date_bounds";
const VALIDATE_CONSTRAINT_FRAGMENT = `VALIDATE CONSTRAINT "${DECISION_DATE_CONSTRAINT}"`;
const DELETE_RECEIPT_CONSTRAINT =
  "corpus_index_projection_intents_delete_receipt_paired";
const VALIDATE_DELETE_RECEIPT_FRAGMENT = `VALIDATE CONSTRAINT "${DELETE_RECEIPT_CONSTRAINT}"`;
/** A pooled session's own timeout, not the role default. */
const SESSION_STATEMENT_TIMEOUT = "30s";
const RESTORED_SESSION_TIMEOUT = `SELECT set_config('statement_timeout', $1, false)\n-- params ${JSON.stringify([SESSION_STATEMENT_TIMEOUT])}`;
const CLEANUP_STALL_CONSTRAINTS = [
  "corpus_index_projection_intents_status_values",
  "corpus_index_projection_intents_status_shape",
  "corpus_index_projection_intents_delete_reissues_nonnegative",
] as const;

describe("online migrations", () => {
  test("keeps executable and validation-only unique indexes in their roles", () => {
    expectTypeOf(
      onlineUniqueIndexDefinition(
        EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CONTACTS_ORG_ID_UNIQUE,
      ),
    ).toExtend<OnlineIndexDeclaration>();
    expectTypeOf<"case_law_decisions_slug_uidx">().not.toExtend<ExecutableOnlineUniqueIndexName>();

    const validationNames = new Set(
      ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS.map(({ name }) => name),
    );
    const rewrittenUniqueNames = REWRITTEN_MIGRATION_INDEXES.filter(
      ({ isUnique }) => isUnique,
    ).map(({ name }) => name);
    expect(rewrittenUniqueNames.length).toBeGreaterThan(0);
    expect(
      rewrittenUniqueNames.filter((name) => !validationNames.has(name)),
    ).toEqual([]);
  });

  const startupIndex = ONLINE_MIGRATION_INDEXES.find(
    ({ name }) => name === REPORT_EXPORT_INDEX,
  );
  if (!startupIndex) {
    throw new TypeError("Expected startup fixture index");
  }

  const startupMigration = startupIndex.introducedBy;
  if (typeof startupMigration !== "string") {
    throw new TypeError("Expected migration-owned startup fixture");
  }

  test.each([
    { label: "missing", state: undefined },
    { label: "invalid", state: false },
    { label: "not ready", state: { isValid: true, isReady: false } },
  ])(
    "reports a newest-set $label index and rejects the same older step",
    async ({ state }) => {
      const pendingNewest = createHarness({
        newestAppliedMigration: startupMigration,
        indexStates: { [startupIndex.name]: [state] },
      });
      expect(await reportOnlineMigrations(pendingNewest.pool)).toEqual({
        newestAppliedMigration: startupMigration,
        pending: [
          {
            kind: "index",
            name: startupIndex.name,
            introducedBy: startupMigration,
          },
        ],
      });
      expect(pendingNewest.released()).toBe(true);
      expect(
        pendingNewest.statements.some((statement) =>
          statement.includes("SELECT pg_advisory_lock("),
        ),
      ).toBe(false);
      expect(
        pendingNewest.statements.some(
          (statement) =>
            statement.includes(CREATE_INDEX_FRAGMENT) ||
            statement.includes(REINDEX_FRAGMENT),
        ),
      ).toBe(false);
      const pendingOlder = createHarness({
        indexStates: { [startupIndex.name]: [state] },
      });
      expect(
        await rejectionOf(reportOnlineMigrations(pendingOlder.pool)),
      ).toMatchObject({
        message: expect.stringContaining(
          `Online index ${startupIndex.name} introduced by ${startupMigration} is not complete`,
        ),
      });
    },
  );

  test.each([true, false])(
    "rejects a definition mismatch even for the newest set (valid=%s)",
    async (isValid) => {
      const harness = createHarness({
        newestAppliedMigration: startupMigration,
        indexStates: {
          [startupIndex.name]: [
            {
              isValid,
              definitionBody: "ON public.report_exports USING btree (id)",
            },
          ],
        },
      });
      expect(
        await rejectionOf(reportOnlineMigrations(harness.pool)),
      ).toMatchObject({
        message: expect.stringContaining(
          `Required migration index ${startupIndex.name} has an unexpected definition`,
        ),
      });
    },
  );

  test("code-owned index artifact reports its source owner", async () => {
    const index = ONLINE_MIGRATION_INDEXES.find(
      ({ introducedBy }) => typeof introducedBy !== "string",
    );
    if (!index || typeof index.introducedBy === "string") {
      throw new TypeError("Expected code-owned index fixture");
    }
    const harness = createHarness({
      artifacts: {
        [index.name]: [{ name: `${index.name}_ccnew`, isValid: true }],
      },
    });
    expect(
      await rejectionOf(reportOnlineMigrations(harness.pool)),
    ).toMatchObject({
      message: `Required migration index ${index.name} owned by ${index.introducedBy.owner} has a valid reindex artifact`,
    });
  });

  test.each([true, false])(
    "validates reindex artifacts before classifying pending work (valid=%s)",
    async (isValid) => {
      const artifacts = {
        [startupIndex.name]: [{ name: `${startupIndex.name}_ccnew`, isValid }],
      };
      const newest = createHarness({
        newestAppliedMigration: startupMigration,
        artifacts,
      });
      if (isValid) {
        expect(
          await rejectionOf(reportOnlineMigrations(newest.pool)),
        ).toMatchObject({
          message: expect.stringContaining("has a valid reindex artifact"),
        });
      } else {
        expect((await reportOnlineMigrations(newest.pool)).pending).toEqual([
          {
            kind: "index",
            name: startupIndex.name,
            introducedBy: startupMigration,
          },
        ]);
      }
      const older = createHarness({ artifacts });
      expect(
        await rejectionOf(reportOnlineMigrations(older.pool)),
      ).toMatchObject({
        message: expect.stringContaining(
          isValid
            ? "has a valid reindex artifact"
            : `introduced by ${startupMigration} is not complete`,
        ),
      });
    },
  );

  test.each(["pending", "incomplete"] as const)(
    "reports newest-set repair %s and rejects the older step",
    async (type) => {
      const introducedBy = startupMigration;
      const completion: OnlineRepairCompletion =
        type === "pending"
          ? {
              type,
              reason: "checkpoint remains",
              cursor: null,
              holdUntil: null,
              heldSince: null,
            }
          : { type, reason: "postcondition remains" };
      const repair = {
        name: "startup-fixture",
        introducedBy,
        readCompletion: async () => completion,
        repair: async () => {
          throw new TypeError("Startup must never repair");
        },
      } satisfies OnlineRepair;
      const newest = createHarness({ newestAppliedMigration: introducedBy });
      expect(
        (await reportOnlineMigrations(newest.pool, { repairs: [repair] }))
          .pending,
      ).toEqual([{ kind: "repair", name: repair.name, introducedBy }]);
      expect(
        await rejectionOf(
          reportOnlineMigrations(createHarness().pool, { repairs: [repair] }),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          `Online repair ${repair.name} introduced by ${introducedBy} is not complete`,
        ),
      });
    },
  );

  test("code-owned repair completion is required independently of the newest migration", async () => {
    const introducedBy = {
      type: "code",
      owner: "src/db/better-auth-oauth-resource-repair.ts",
    } as const;
    const repair = {
      name: "code-owned-fixture",
      introducedBy,
      readCompletion: async () => ({ type: "complete" }) as const,
      repair: async () => {
        throw new TypeError("Startup must never repair");
      },
    } satisfies OnlineRepair;
    const complete = createHarness();
    expect(
      (await reportOnlineMigrations(complete.pool, { repairs: [repair] }))
        .pending,
    ).toEqual([]);
    const incomplete = {
      ...repair,
      readCompletion: async () =>
        ({ type: "incomplete", reason: "live postcondition remains" }) as const,
    } satisfies OnlineRepair;
    expect(
      await rejectionOf(
        reportOnlineMigrations(createHarness().pool, { repairs: [incomplete] }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "owned by src/db/better-auth-oauth-resource-repair.ts is not complete",
      ),
    });
    const wrongMigration = {
      ...incomplete,
      introducedBy: "missing-migration",
    } satisfies OnlineRepair;
    expect(
      await rejectionOf(
        reportOnlineMigrations(createHarness().pool, {
          repairs: [wrongMigration],
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "introduced by missing-migration is not complete",
      ),
    });
  });

  test("reports a newest-set cutover and rejects its older pending state", async () => {
    const cutover = FILTER_INDEX_CUTOVER;
    const newest = createHarness({
      newestAppliedMigration: cutover.introducedBy,
      indexStates: {
        [cutover.final.name]: [undefined],
        [cutover.staged.name]: [true],
      },
    });
    expect((await reportOnlineMigrations(newest.pool)).pending).toEqual([
      {
        kind: "cutover",
        name: cutover.final.name,
        introducedBy: cutover.introducedBy,
      },
    ]);
    expect(
      await rejectionOf(
        reportOnlineMigrations(
          createHarness({ indexStates: { [cutover.final.name]: [undefined] } })
            .pool,
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        `introduced by ${cutover.introducedBy} is not complete`,
      ),
    });
  });

  test("reports a newest-set cutover while the final index has its legacy definition", async () => {
    const cutover = FILTER_INDEX_CUTOVER;
    const harness = createHarness({
      newestAppliedMigration: cutover.introducedBy,
      indexStates: {
        [cutover.final.name]: [
          {
            isValid: true,
            definitionBody: cutover.legacy.definitionBody,
          },
        ],
        [cutover.staged.name]: [true],
      },
    });

    expect(await reportOnlineMigrations(harness.pool)).toEqual({
      newestAppliedMigration: cutover.introducedBy,
      pending: [
        {
          kind: "cutover",
          name: cutover.final.name,
          introducedBy: cutover.introducedBy,
        },
      ],
    });
  });

  test("rejects an unexpected final index definition during a newest-set cutover", async () => {
    const cutover = FILTER_INDEX_CUTOVER;
    const harness = createHarness({
      newestAppliedMigration: cutover.introducedBy,
      indexStates: {
        [cutover.final.name]: [
          {
            isValid: true,
            definitionBody:
              "ON public.case_law_decisions USING btree (document_date)",
          },
        ],
        [cutover.staged.name]: [true],
      },
    });

    expect(
      await rejectionOf(reportOnlineMigrations(harness.pool)),
    ).toMatchObject({
      message: expect.stringContaining(
        `Required migration index ${cutover.final.name} has an unexpected definition`,
      ),
    });
  });

  test("reports a completed cutover when the final index has its new definition", async () => {
    const cutover = FILTER_INDEX_CUTOVER;
    const harness = createHarness({
      newestAppliedMigration: cutover.introducedBy,
      indexStates: {
        [cutover.final.name]: [true],
        [cutover.staged.name]: [undefined],
      },
    });

    expect(await reportOnlineMigrations(harness.pool)).toEqual({
      newestAppliedMigration: cutover.introducedBy,
      pending: [],
    });
  });

  test("reports publisher identity indexes and their legacy retirements as newest-set work", async () => {
    const introducedBy = "20261019091000_legislation_publisher_identity";
    const missingIndexes = [
      "legislation_documents_work_version_lang_idx",
      "legislation_documents_publisher_identity_idx",
      "legislation_documents_legacy_version_lang_idx",
      "legislation_documents_legacy_current_lang_idx",
    ];
    const legacyNames = [
      "legislation_documents_eli_version_lang_idx",
      "legislation_documents_eli_current_lang_idx",
    ];
    const harness = createHarness({
      newestAppliedMigration: introducedBy,
      missingIndexes,
      indexStates: Object.fromEntries(
        legacyNames.map((name) => [name, [true]]),
      ),
    });

    expect(await reportOnlineMigrations(harness.pool)).toEqual({
      newestAppliedMigration: introducedBy,
      pending: [
        ...missingIndexes.map((name) => ({
          kind: "index" as const,
          name,
          introducedBy,
        })),
        ...legacyNames.map((name) => ({
          kind: "replacement_drop" as const,
          name,
          introducedBy,
        })),
      ],
    });
  });

  test("reports newest-set retirement work and rejects an older leftover", async () => {
    const replacement = ONLINE_INDEX_REPLACEMENTS.find(
      ({ introducedBy }) => typeof introducedBy === "string",
    );
    if (!replacement || typeof replacement.introducedBy !== "string") {
      throw new TypeError("Expected migration-owned retirement fixture");
    }
    const states = { [replacement.legacyName]: [true] };
    const newest = createHarness({
      newestAppliedMigration: replacement.introducedBy,
      indexStates: states,
    });
    expect((await reportOnlineMigrations(newest.pool)).pending).toEqual([
      {
        kind: "replacement_drop",
        name: replacement.legacyName,
        introducedBy: replacement.introducedBy,
      },
    ]);
    expect(
      await rejectionOf(
        reportOnlineMigrations(createHarness({ indexStates: states }).pool),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        `introduced by ${replacement.introducedBy} is not complete`,
      ),
    });
  });

  /**
   * The online phase runs inside the release's migrate run, so a walk or a
   * full-table scan there holds the release for its whole length. The
   * provision state backfill is a scheduler job instead.
   */
  test("keeps the provision state backfill out of the online phase", () => {
    const repairNames = new Set(
      ONLINE_MIGRATION_REPAIRS.map(({ name }) => name),
    );
    expect(PROVISION_STATE_BACKFILL_STEPS.length).toBeGreaterThan(0);
    expect(
      PROVISION_STATE_BACKFILL_STEPS.filter(({ name }) =>
        repairNames.has(name),
      ),
    ).toEqual([]);
    expect(
      [...repairNames].filter((name) => name.includes("provision")),
    ).toEqual([]);
  });

  test("startup validation never waits on the online lock and bounds its own statements", async () => {
    const harness = createHarness();
    expect(await reportOnlineMigrations(harness.pool)).toEqual({
      newestAppliedMigration: "99999999999999_later_release",
      pending: [],
    });
    expect(harness.statements.at(1)).toBe("SET statement_timeout = '5s'");
    expect(harness.statements.at(-1)).toBe(RESTORED_SESSION_TIMEOUT);
    expect(
      harness.statements.filter((statement) =>
        statement.includes("SELECT pg_advisory_lock("),
      ),
    ).toEqual([]);
    expect(harness.released()).toBe(true);
  });

  test("startup leaves the online phase to a migrate run that holds the lock", async () => {
    const harness = createHarness({
      missingIndexes: ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
      onlineLockHeld: true,
    });
    expect(await reportOnlineMigrationsWithOwnership(harness.pool)).toEqual({
      type: "migrator_active",
    });
    expect(
      harness.statements.filter(
        (statement) =>
          statement.includes("pg_catalog") ||
          statement.includes("pg_advisory_unlock"),
      ),
    ).toEqual([]);
    expect(harness.statements.at(-1)).toBe(RESTORED_SESSION_TIMEOUT);
    expect(harness.released()).toBe(true);
  });

  test.each(SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS)(
    "validates monitoring constraint $name once and rejects incomplete startup",
    async ({ name }) => {
      const harness = createHarness({ unvalidatedConstraints: [name] });
      const rejection = await reportOnlineMigrations(harness.pool).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toMatchObject({
        message: expect.stringMatching(
          new RegExp(
            `Online repair ${name} introduced by .* is not complete: constraint ${name} is not validated`,
            "u",
          ),
        ),
      });
      const beforeRepair = harness.statements.length;
      await runOnlineMigrations(harness.pool);
      await reportOnlineMigrations(harness.pool);
      await runOnlineMigrations(harness.pool);
      const validations = harness.statements
        .slice(beforeRepair)
        .filter((statement) =>
          statement.includes(`VALIDATE CONSTRAINT "${name}"`),
        );
      expect(validations).toHaveLength(1);
      expect(harness.released()).toBe(true);
    },
  );

  test("validates the account audit event check once and rejects incomplete startup", async () => {
    const { name } = ACCOUNT_AUDIT_CONSTRAINT_VALIDATION;
    const harness = createHarness({ unvalidatedConstraints: [name] });
    const rejection = await reportOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Online repair ${name} introduced by ${ACCOUNT_AUDIT_CONSTRAINT_VALIDATION.introducedBy} is not complete: constraint ${name} is not validated`,
    });
    const beforeRepair = harness.statements.length;
    await runOnlineMigrations(harness.pool);
    await reportOnlineMigrations(harness.pool);
    await runOnlineMigrations(harness.pool);
    expect(
      harness.statements
        .slice(beforeRepair)
        .filter((statement) =>
          statement.includes(`VALIDATE CONSTRAINT "${name}"`),
        ),
    ).toHaveLength(1);
    expect(harness.released()).toBe(true);
  });

  test("every validation a registered repair runs is declared, and each runs once", async () => {
    const declared = ONLINE_CONSTRAINT_VALIDATIONS.map(
      ({ tableName, constraintName }) =>
        `ALTER TABLE public."${tableName}" VALIDATE CONSTRAINT "${constraintName}"`,
    );
    expect(new Set(declared).size).toBe(declared.length);
    const harness = createHarness({
      emptyRepairTables: true,
      unvalidatedConstraints: ONLINE_CONSTRAINT_VALIDATIONS.map(
        ({ constraintName }) => constraintName,
      ),
    });
    expect(await runOnlineMigrations(harness.pool)).toEqual({
      type: "complete",
    });
    await reportOnlineMigrations(harness.pool);
    expect(
      harness.statements
        .filter((statement) => statement.includes("VALIDATE CONSTRAINT"))
        .toSorted(),
    ).toEqual(declared.toSorted());
  });

  test("accepts an already valid index without rebuilding it", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("every online step reports its duration, in the order the phase runs them", async () => {
    const harness = createHarness();
    const records: MigrationTimingRecord[] = [];
    let now = 0;

    await runOnlineMigrations(harness.pool, {
      timing: {
        clock: () => (now += 5),
        emit: (record) => {
          records.push(record);
        },
      },
    });

    const steps = records.flatMap((record) =>
      record.event === "migrate.online_step_duration" ? [record] : [],
    );
    expect(steps).toHaveLength(records.length);
    const named = (kind: string) =>
      steps.filter((step) => step.kind === kind).map(({ name }) => name);
    expect(named("index")).toEqual(
      ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
    );
    expect(named("cutover")).toEqual(
      ONLINE_MIGRATION_INDEX_CUTOVERS.map(({ final }) => final.name),
    );
    expect(named("replacement_drop").length).toBeGreaterThan(0);
    // Indexes, then cutovers, then the replaced indexes they retire.
    expect(steps.map(({ kind }) => kind)).toEqual(
      [...steps.map(({ kind }) => kind)].toSorted(
        (left, right) =>
          ["index", "cutover", "replacement_drop", "repair"].indexOf(left) -
          ["index", "cutover", "replacement_drop", "repair"].indexOf(right),
      ),
    );
    for (const step of steps) {
      expect(step.durationMs, step.name).toBe(5);
      expect(step.retriesSpent, step.name).toBe(0);
      expect(step.outcome, step.name).toBe("complete");
    }
  });

  test("a deferred index is the last step reported, as deferred", async () => {
    const harness = createHarness({
      indexStates: { [REPORT_EXPORT_INDEX]: [undefined, undefined] },
    });
    const records: MigrationTimingRecord[] = [];

    const outcome = await runOnlineMigrations(harness.pool, {
      indexGate: {
        ...healthyIndexGate,
        ebs: {
          type: "reader",
          read: async () => ({
            indicator: "ebs_balance",
            kind: "unknown",
            value: null,
            threshold: 70,
            observedAt: null,
            reason: "Injected unavailable metric",
          }),
        },
      },
      timing: {
        clock: () => 0,
        emit: (record) => {
          records.push(record);
        },
      },
    });

    expect(outcome.type).toBe("deferred");
    expect(records.at(-1)).toEqual({
      event: "migrate.online_step_duration",
      kind: "index",
      name: REPORT_EXPORT_INDEX,
      durationMs: 0,
      retriesSpent: 0,
      outcome: "deferred",
    });
  });

  test("creates a missing index online and verifies completion", async () => {
    for (const { name } of ONLINE_MIGRATION_INDEXES.filter(
      declaresOnlineBuild,
    )) {
      const harness = createHarness({ missingIndexes: [name] });

      await runOnlineMigrations(harness.pool);

      expect(
        indexOfStatement(harness.statements, `INDEX CONCURRENTLY "${name}"`),
        name,
      ).toBeGreaterThan(-1);
      expect(harness.released()).toBe(true);
    }
  });

  test("refuses an online build without a declared create statement", async () => {
    const declared = ONLINE_MIGRATION_INDEXES.find(
      ({ name }) => name === REPORT_EXPORT_INDEX,
    );
    if (!declared) {
      throw new TypeError("Expected the report export index declaration");
    }
    const index = {
      definitionBody: declared.definitionBody,
      isUnique: declared.isUnique,
      name: declared.name,
      tableName: declared.tableName,
    };
    const harness = createHarness({
      indexStates: { [REPORT_EXPORT_INDEX]: [false, undefined] },
    });
    const connection = await harness.pool.reserve();

    const rejection = await rejectionOf(
      ensureOnlineIndexValid({
        connection,
        gate: healthyIndexGate,
        index,
        reserveObserver: reserveHealthyObserver,
      }),
    );

    expect(String(rejection)).toContain(
      `Required migration index ${REPORT_EXPORT_INDEX} is missing`,
    );
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
  });

  /**
   * A gate that sleeps until health returns would hold the migrate run for
   * that long. A held build ends the phase instead, and nothing after it runs:
   * later steps may depend on the index it would have built.
   */
  test("defers at an index the gate holds, without waiting or running a later step", async () => {
    const heldIndexAt = ONLINE_MIGRATION_INDEXES.findIndex(
      ({ name }) => name === REPORT_EXPORT_INDEX,
    );
    const laterIndexes = ONLINE_MIGRATION_INDEXES.slice(heldIndexAt + 1);
    expect(laterIndexes.length).toBeGreaterThan(0);
    const harness = createHarness({
      indexStates: {
        [REPORT_EXPORT_INDEX]: [undefined, undefined, undefined, true],
      },
    });
    const waits: number[] = [];

    const held = await runOnlineMigrations(harness.pool, {
      indexGate: {
        ...healthyIndexGate,
        ebs: {
          type: "reader",
          read: async () => ({
            indicator: "ebs_balance",
            kind: "unknown",
            value: null,
            threshold: 70,
            observedAt: null,
            reason: "Injected unavailable metric",
          }),
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    });

    expect(held).toEqual({
      type: "deferred",
      step: REPORT_EXPORT_INDEX,
      retryAfterMs: healthyIndexGate.config.retryMs,
    });
    expect(waits).toEqual([]);
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    for (const { name } of laterIndexes) {
      expect(indexOfStatement(harness.statements, `"${name}"`), name).toBe(-1);
    }
    expect(indexOfStatement(harness.statements, FILTER_INDEX)).toBe(-1);
    expect(
      indexOfStatement(harness.statements, "DROP INDEX CONCURRENTLY IF EXISTS"),
    ).toBe(-1);
    expect(indexOfStatement(harness.statements, "pg_constraint")).toBe(-1);
    expect(
      indexOfStatement(
        harness.statements,
        "pg_advisory_unlock(hashtext('stella-online-migrations'))",
      ),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);

    // The next run resumes at the held index once the gate admits it, and
    // only then reaches the steps after it.
    const resumedAt = harness.statements.length;
    expect(await runOnlineMigrations(harness.pool)).toEqual({
      type: "complete",
    });
    const resumed = harness.statements.slice(resumedAt);
    expect(
      indexOfStatement(
        resumed,
        `${CREATE_INDEX_FRAGMENT} "${REPORT_EXPORT_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(indexOfStatement(resumed, "pg_constraint")).toBeGreaterThan(-1);
  });

  for (const { final, staged } of ONLINE_MIGRATION_INDEX_CUTOVERS) {
    for (const stage of ["missing", "invalid"] as const) {
      test(`a held ${stage} stage preserves ${final.name} and defers every later phase`, async () => {
        const harness = createHarness({
          indexStates: {
            [final.name]: [
              {
                definitionBody:
                  "ON public.case_law_decisions USING btree (updated_at, id)",
                isValid: true,
              },
            ],
            [staged.name]: [stage === "missing" ? undefined : false],
          },
        });
        const waits: number[] = [];
        expect(
          await runOnlineMigrations(harness.pool, {
            indexGate: {
              ...heldIndexGate,
              wait: async (milliseconds) => {
                waits.push(milliseconds);
              },
            },
          }),
        ).toEqual({
          type: "deferred",
          step: staged.name,
          retryAfterMs: heldIndexGate.config.retryMs,
        });
        expect(waits).toEqual([]);
        for (const fragment of [
          CREATE_INDEX_FRAGMENT,
          REINDEX_FRAGMENT,
          DROP_INDEX_FRAGMENT,
          "ALTER INDEX",
          "pg_constraint",
          "database_backfill_states",
        ]) {
          expect(indexOfStatement(harness.statements, fragment), fragment).toBe(
            -1,
          );
        }
        expect(harness.released()).toBe(true);
      });
    }
  }

  test("online migration retries share the hold through the actual index gate and alert once", async () => {
    const harness = createHarness({
      indexStates: { [REPORT_EXPORT_INDEX]: [undefined] },
    });
    const hold = createOnlineIndexHold();
    let now = testClock();
    const records: unknown[] = [];
    const indexGate = {
      ...heldIndexGate,
      hold,
      clock: () => now,
      log: (record: unknown) => {
        records.push(record);
      },
    };
    const run = async () => {
      expect(
        await runOnlineMigrations(harness.pool, { indexGate }),
      ).toMatchObject({
        type: "deferred",
        step: REPORT_EXPORT_INDEX,
      });
    };
    const alerts = () =>
      records.filter(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "event" in record &&
          record.event === "database_load_gate_held_too_long",
      );
    await run();
    expect(hold.current).toEqual({ type: "held", since: now });
    expect(alerts()).toHaveLength(0);
    now += indexGate.config.health.maxHeldMs + 1;
    await run();
    expect(alerts()).toHaveLength(1);
    await run();
    expect(alerts()).toHaveLength(1);
    expect(hold.current).toEqual({ type: "alerted", since: testClock() });
  });

  test("concurrently repairs an interrupted invalid build", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [false, false, true] },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${REINDEX_FRAGMENT} public."${CREDENTIAL_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  /**
   * A concurrent build interrupted after PostgreSQL marked the index ready
   * leaves it INVALID but maintained, and a unique one keeps rejecting
   * duplicates. Dropping it before its replacement is valid would let a
   * duplicate commit, after which the rebuild fails for good.
   */
  test("never drops a ready invalid index it repairs, so uniqueness stays enforced", async () => {
    const readyInvalid = { isReady: true, isValid: false } as const;
    expect(ONLINE_MIGRATION_INDEXES.some(({ isUnique }) => isUnique)).toBe(
      true,
    );
    for (const { name } of ONLINE_MIGRATION_INDEXES) {
      const harness = createHarness({
        indexStates: { [name]: [readyInvalid, readyInvalid, true] },
      });

      await runOnlineMigrations(harness.pool);

      expect(
        indexOfStatement(
          harness.statements,
          `${DROP_INDEX_FRAGMENT} public."${name}"`,
        ),
        name,
      ).toBe(-1);
      expect(
        indexOfStatement(
          harness.statements,
          `${REINDEX_FRAGMENT} public."${name}"`,
        ),
        name,
      ).toBeGreaterThan(-1);
      expect(
        indexOfStatement(harness.statements, `INDEX CONCURRENTLY "${name}"`),
        name,
      ).toBe(-1);
    }
  });

  test("drops an interrupted reindex artifact before retrying", async () => {
    const artifactName = `${CREDENTIAL_INDEX}_ccnew`;
    const harness = createHarness({
      artifacts: {
        [CREDENTIAL_INDEX]: [{ isValid: false, name: artifactName }],
      },
      indexStates: { [CREDENTIAL_INDEX]: [false, false, true] },
    });

    await runOnlineMigrations(harness.pool);

    const drop = indexOfStatement(
      harness.statements,
      `${DROP_INDEX_FRAGMENT} public."${artifactName}"`,
    );
    expect(drop).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${REINDEX_FRAGMENT} public."${CREDENTIAL_INDEX}"`,
      ),
    ).toBeGreaterThan(drop);
  });

  test("repairs an invalid chat run index after an interrupted build", async () => {
    expect(
      ONLINE_MIGRATION_INDEXES.some(({ name }) => name === CHAT_RUN_INDEX),
    ).toBe(true);
    const artifactName = `${CHAT_RUN_INDEX}_ccnew`;
    const harness = createHarness({
      artifacts: {
        [CHAT_RUN_INDEX]: [{ isValid: false, name: artifactName }],
      },
      indexStates: { [CHAT_RUN_INDEX]: [false, false, true] },
    });

    await runOnlineMigrations(harness.pool);

    const drop = indexOfStatement(
      harness.statements,
      `${DROP_INDEX_FRAGMENT} public."${artifactName}"`,
    );
    const repair = indexOfStatement(
      harness.statements,
      `${REINDEX_FRAGMENT} public."${CHAT_RUN_INDEX}"`,
    );
    expect(drop).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(drop);
    expect(harness.released()).toBe(true);
  });

  test("rejects a valid same-named index with the wrong definition", async () => {
    const harness = createHarness({
      indexStates: {
        [CREDENTIAL_INDEX]: [
          {
            definitionBody: "ON public.account USING btree (id)",
            isValid: true,
          },
        ],
      },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} has an unexpected definition`,
    });
  });

  test("startup validation rejects an invalid required index", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [false] },
    });

    const rejection: unknown = await reportOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `Online index ${CREDENTIAL_INDEX} introduced by .* is not complete:`,
          "u",
        ),
      ),
    });
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
  });

  test("startup refuses an incomplete code-owned index retirement", async () => {
    const retirementName = "case_law_provision_citations_work_subtree_idx";
    const harness = createHarness({
      retiredIndexes: ONLINE_INDEX_REPLACEMENTS.map(
        ({ legacyName }) => legacyName,
      ).filter((name) => name !== retirementName),
    });
    expect(
      await rejectionOf(reportOnlineMigrations(harness.pool)),
    ).toMatchObject({
      message: `Online replacement_drop ${retirementName} owned by src/db/online-migrations.ts is not complete: retired index remains`,
    });
  });

  test("retires a legacy index only after both replacements validate", async () => {
    const harness = createHarness({ retiredIndexes: [] });

    await runOnlineMigrations(harness.pool);

    const dropOffset = indexOfStatement(
      harness.statements,
      `DROP INDEX CONCURRENTLY IF EXISTS public."${LEGACY_SOURCE_CASE_INDEX}"`,
    );
    expect(dropOffset).toBeGreaterThan(
      indexOfStatement(harness.statements, SOURCE_DOCUMENT_INDEX),
    );
    expect(dropOffset).toBeGreaterThan(
      indexOfStatement(harness.statements, SOURCE_CASE_INDEX),
    );
  });

  test("retires the broad document index only after its exact replacement validates", async () => {
    const harness = createHarness({
      retiredIndexes: [],
      missingIndexes: [DOCUMENT_DATE_INDEX],
    });

    await runOnlineMigrations(harness.pool);

    const createOffset = indexOfStatement(
      harness.statements,
      `${CREATE_INDEX_FRAGMENT} "${DOCUMENT_DATE_INDEX}"`,
    );
    const dropOffset = indexOfStatement(
      harness.statements,
      `DROP INDEX CONCURRENTLY IF EXISTS public."${LEGACY_DOCUMENT_DATE_INDEX}"`,
    );
    expect(createOffset).toBeGreaterThan(-1);
    expect(dropOffset).toBeGreaterThan(createOffset);
  });

  test("preserves the broad document index when its replacement loses validity", async () => {
    const harness = createHarness({
      retiredIndexes: [],
      indexStates: { [DOCUMENT_DATE_INDEX]: [true, false] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${DOCUMENT_DATE_INDEX} is not ready`,
    });
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(
      indexOfStatement(harness.statements, LEGACY_DOCUMENT_DATE_INDEX),
    ).toBe(-1);
  });

  test("retires the account issuer index only after its replacement validates", async () => {
    const harness = createHarness({ retiredIndexes: [] });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `DROP INDEX CONCURRENTLY IF EXISTS public."${LEGACY_ACCOUNT_INDEX}"`,
      ),
    ).toBeGreaterThan(indexOfStatement(harness.statements, ACCOUNT_INDEX));
  });

  test("preserves the account issuer index when its replacement is not ready", async () => {
    // Valid on the index phase's read, not ready on the retirement gate's:
    // the phase has to pass for the gate to be what refuses, and an invalid
    // state on both reads would fail during the phase instead, leaving the
    // legacy drop unreached for the wrong reason.
    const harness = createHarness({
      retiredIndexes: [],
      indexStates: { [ACCOUNT_INDEX]: [true, false] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${ACCOUNT_INDEX} is not ready`,
    });
    // The phase found the replacement valid, so it neither rebuilt nor
    // reindexed it; the gate is the only thing that refused.
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(indexOfStatement(harness.statements, LEGACY_ACCOUNT_INDEX)).toBe(-1);
  });

  test("preserves a legacy index when a replacement is not ready", async () => {
    // Valid on the index phase's read, not ready on the retirement gate's, so
    // the gate is what refuses. Invalid on both reads would fail during the
    // phase instead and never reach the gate this test is about.
    const harness = createHarness({
      retiredIndexes: [],
      indexStates: { [SOURCE_CASE_INDEX]: [true, false] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${SOURCE_CASE_INDEX} is not ready`,
    });
    // The phase found both replacements valid, so it neither rebuilt nor
    // reindexed either one.
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(indexOfStatement(harness.statements, LEGACY_SOURCE_CASE_INDEX)).toBe(
      -1,
    );
  });

  test("defers at a replaced index the gate holds, keeping it and skipping later steps", async () => {
    const harness = createHarness({ retiredIndexes: [] });
    const records: MigrationTimingRecord[] = [];
    const firstLegacy = ONLINE_INDEX_REPLACEMENTS.at(0)?.legacyName;
    if (firstLegacy === undefined) {
      throw new TypeError("Expected a replaced index");
    }

    const outcome = await runOnlineMigrations(harness.pool, {
      indexGate: heldIndexGate,
      timing: {
        clock: () => 0,
        emit: (record) => {
          records.push(record);
        },
      },
    });

    expect(outcome).toEqual({
      type: "deferred",
      step: firstLegacy,
      retryAfterMs: heldIndexGate.config.retryMs,
    });
    expect(records.at(-1)).toEqual({
      event: "migrate.online_step_duration",
      kind: "replacement_drop",
      name: firstLegacy,
      durationMs: 0,
      retriesSpent: 0,
      outcome: "deferred",
    });
    expect(indexOfStatement(harness.statements, DROP_INDEX_FRAGMENT)).toBe(-1);
    expect(indexOfStatement(harness.statements, "VALIDATE CONSTRAINT")).toBe(
      -1,
    );
    expect(harness.released()).toBe(true);
  });

  test("retired indexes cost only a catalog read, so a held gate never defers over them", async () => {
    const harness = createHarness({
      retiredIndexes: ONLINE_INDEX_REPLACEMENTS.map(
        ({ legacyName }) => legacyName,
      ),
    });

    expect(
      await runOnlineMigrations(harness.pool, { indexGate: heldIndexGate }),
    ).toEqual({ type: "complete" });
    expect(indexOfStatement(harness.statements, DROP_INDEX_FRAGMENT)).toBe(-1);
  });

  test.each(SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS)(
    "defers at validation $name while the gate holds it, then validates it on a healthy run",
    async ({ name }) => {
      const harness = createHarness({
        unvalidatedConstraints: [name],
        retiredIndexes: ONLINE_INDEX_REPLACEMENTS.map(
          ({ legacyName }) => legacyName,
        ),
      });
      const records: MigrationTimingRecord[] = [];

      expect(
        await runOnlineMigrations(harness.pool, {
          indexGate: heldIndexGate,
          timing: {
            clock: () => 0,
            emit: (record) => {
              records.push(record);
            },
          },
        }),
      ).toEqual({
        type: "deferred",
        step: name,
        retryAfterMs: heldIndexGate.config.retryMs,
      });
      expect(records.at(-1)).toEqual({
        event: "migrate.online_step_duration",
        kind: "repair",
        name,
        durationMs: 0,
        retriesSpent: 0,
        outcome: "deferred",
      });
      expect(
        indexOfStatement(harness.statements, `VALIDATE CONSTRAINT "${name}"`),
      ).toBe(-1);
      // Deferred, not deployable: startup still refuses the NOT VALID check.
      expect(
        String(await rejectionOf(reportOnlineMigrations(harness.pool))),
      ).toContain(`Online repair ${name} introduced by`);

      expect(await runOnlineMigrations(harness.pool)).toEqual({
        type: "complete",
      });
      await reportOnlineMigrations(harness.pool);
      const validated = harness.statements.length;
      // A validated constraint costs one catalog read, so a held gate never
      // defers over it again.
      expect(
        await runOnlineMigrations(harness.pool, { indexGate: heldIndexGate }),
      ).toEqual({ type: "complete" });
      expect(
        harness.statements
          .slice(validated)
          .filter((statement) => statement.includes("VALIDATE CONSTRAINT")),
      ).toEqual([]);
      expect(harness.released()).toBe(true);
    },
  );

  test("a second run after every drop is a fixed point", async () => {
    const harness = createHarness({ retiredIndexes: [] });

    expect(await runOnlineMigrations(harness.pool)).toEqual({
      type: "complete",
    });
    const afterFirstRun = harness.statements.length;
    expect(
      await runOnlineMigrations(harness.pool, { indexGate: heldIndexGate }),
    ).toEqual({ type: "complete" });
    expect(
      indexOfStatement(
        harness.statements.slice(afterFirstRun),
        DROP_INDEX_FRAGMENT,
      ),
    ).toBe(-1);
  });

  test("rejects a missing index required by a rewritten migration", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [undefined] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} is missing`,
    });
    expect(harness.released()).toBe(true);
  });

  test("reuses a valid staged index when retrying the cutover", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [undefined, true],
        [FILTER_INDEX_REPLACEMENT]: [true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `ALTER INDEX public."${FILTER_INDEX_REPLACEMENT}" RENAME TO "${FILTER_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
      ),
    ).toBe(-1);
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
  });

  test("keeps a ready final index and removes a stale staged copy", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [true],
        [FILTER_INDEX_REPLACEMENT]: [true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX}"`,
      ),
    ).toBe(-1);
  });

  test("cleans interrupted final-index maintenance before completing", async () => {
    const artifactName = `${FILTER_INDEX}_ccnew`;
    const harness = createHarness({
      artifacts: {
        [FILTER_INDEX]: [{ isValid: false, name: artifactName }],
      },
      indexStates: {
        [FILTER_INDEX]: [true, true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${artifactName}"`,
      ),
    ).toBeGreaterThan(-1);
  });

  test("repairs the staged index before replacing an older definition", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [
          {
            definitionBody:
              "ON public.case_law_decisions USING btree (updated_at, id)",
            isValid: true,
          },
          true,
        ],
        [FILTER_INDEX_REPLACEMENT]: [false, false, true],
      },
    });

    await runOnlineMigrations(harness.pool);

    const reindexOffset = indexOfStatement(
      harness.statements,
      `${REINDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
    );
    const dropOffset = indexOfStatement(
      harness.statements,
      `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX}"`,
    );
    const renameOffset = indexOfStatement(
      harness.statements,
      `ALTER INDEX public."${FILTER_INDEX_REPLACEMENT}" RENAME TO "${FILTER_INDEX}"`,
    );
    expect(reindexOffset).toBeGreaterThan(-1);
    expect(dropOffset).toBeGreaterThan(reindexOffset);
    expect(renameOffset).toBeGreaterThan(dropOffset);
  });

  test("defers the decision-date repair when health cannot be read", async () => {
    const harness = createHarness({
      newestAppliedMigration: DECISION_DATE_CEILING_REPAIR.introducedBy,
      unvalidatedConstraints: [DECISION_DATE_CONSTRAINT],
    });
    const pending: unknown[] = [];
    await runOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    const startup = await reportOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    expect(startup.pending).toEqual([
      {
        kind: "repair",
        name: DECISION_DATE_CEILING_REPAIR.name,
        introducedBy: DECISION_DATE_CEILING_REPAIR.introducedBy,
      },
    ]);
    expect(pending).toHaveLength(1);
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "online_repair_pending",
          completion: expect.objectContaining({
            type: "pending",
            holdUntil: expect.any(Number),
            heldSince: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBe(-1);
    expect(
      indexOfStatement(harness.statements, "corrupt AS MATERIALIZED"),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("validates the cleanup-stall checks without walking the intents", async () => {
    const harness = createHarness({
      unvalidatedConstraints: CLEANUP_STALL_CONSTRAINTS,
    });

    await runOnlineMigrations(harness.pool);
    await reportOnlineMigrations(harness.pool);

    for (const constraint of CLEANUP_STALL_CONSTRAINTS) {
      expect(
        indexOfStatement(
          harness.statements,
          `VALIDATE CONSTRAINT "${constraint}"`,
        ),
      ).toBeGreaterThan(-1);
    }
    expect(
      indexOfStatement(
        harness.statements,
        'UPDATE public."corpus_index_projection_intents"',
      ),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("startup validation rejects an unvalidated cleanup-stall check without repairing", async () => {
    const [constraint] = CLEANUP_STALL_CONSTRAINTS;
    const harness = createHarness({ unvalidatedConstraints: [constraint] });

    const rejection: unknown = await reportOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `Online repair corpus-projection-cleanup-stall introduced by .* is not complete: constraint ${constraint} is not validated`,
          "u",
        ),
      ),
    });
    expect(
      indexOfStatement(
        harness.statements,
        `VALIDATE CONSTRAINT "${constraint}"`,
      ),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("defers the delete-receipt walk when health cannot be read", async () => {
    const harness = createHarness({
      newestAppliedMigration:
        CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR.introducedBy,
      unvalidatedConstraints: [DELETE_RECEIPT_CONSTRAINT],
    });
    const pending: unknown[] = [];
    await runOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    const startup = await reportOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    expect(startup.pending).toEqual([
      {
        kind: "repair",
        name: CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR.name,
        introducedBy: CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR.introducedBy,
      },
    ]);
    expect(pending).toHaveLength(1);
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "online_repair_pending",
          completion: expect.objectContaining({
            type: "pending",
            holdUntil: expect.any(Number),
            heldSince: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(
      indexOfStatement(harness.statements, VALIDATE_DELETE_RECEIPT_FRAGMENT),
    ).toBe(-1);
    expect(
      indexOfStatement(
        harness.statements,
        'UPDATE public."corpus_index_projection_intents"',
      ),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("a repair its completion check rejects is reported as failed, never as pending", async () => {
    const harness = createHarness();
    const records: MigrationTimingRecord[] = [];
    const completions: OnlineRepairCompletion[] = [
      { type: "incomplete", reason: "not started" },
      { type: "incomplete", reason: "rows left behind" },
    ];
    const repair = {
      introducedBy: "20261001123000_database_backfill_state",
      name: "probe-repair",
      readCompletion: async () =>
        completions.shift() ?? {
          type: "incomplete",
          reason: "unexpected read",
        },
      repair: async () => ({ type: "complete" }) as const,
    } satisfies OnlineRepair;

    const failure = await rejectionOf(
      runOnlineMigrations(harness.pool, {
        repairs: [repair],
        timing: {
          clock: () => 0,
          emit: (record) => {
            records.push(record);
          },
        },
      }),
    );

    expect(String(failure)).toContain("probe-repair");
    expect(records.at(-1)).toEqual({
      event: "migrate.online_step_duration",
      kind: "repair",
      name: "probe-repair",
      durationMs: 0,
      retriesSpent: 0,
      outcome: "failed",
    });
  });

  test("a migrate-phase batch statement timeout stays pending and deployment proceeds", async () => {
    const harness = createHarness({
      newestAppliedMigration: DECISION_DATE_CEILING_REPAIR.introducedBy,
      unvalidatedConstraints: [DECISION_DATE_CONSTRAINT],
      timeoutRepairBatch: true,
    });
    const repair = createDecisionDateCeilingRepair({
      readVerdict: async () => ({ kind: "normal", signals: [] }),
      clock: () => 0,
      log: () => undefined,
    });
    const pending: unknown[] = [];
    await runOnlineMigrations(harness.pool, {
      repairs: [repair],
      log: (record) => {
        pending.push(record);
      },
    });
    const startup = await reportOnlineMigrations(harness.pool, {
      repairs: [repair],
      log: (record) => {
        pending.push(record);
      },
    });
    expect(startup.pending).toEqual([
      {
        kind: "repair",
        name: DECISION_DATE_CEILING_REPAIR.name,
        introducedBy: DECISION_DATE_CEILING_REPAIR.introducedBy,
      },
    ]);
    expect(pending).toHaveLength(1);
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "online_repair_pending",
          repair: repair.name,
          completion: expect.objectContaining({
            type: "pending",
            holdUntil: null,
            heldSince: null,
          }),
        }),
      ]),
    );
    expect(
      indexOfStatement(harness.statements, "corrupt AS MATERIALIZED"),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("a hold without a durable checkpoint remains a deployment failure", async () => {
    const harness = createHarness();
    const rejection: unknown = await runOnlineMigrations(harness.pool, {
      repairs: [
        {
          introducedBy: "20261001123000_database_backfill_state",
          name: "unpersisted-hold",
          readCompletion: async () => ({
            type: "incomplete",
            reason: "not attempted",
          }),
          repair: async () => {
            throw new BackfillHeldError({
              message: "held",
              holdUntil: 1,
              heldSince: 0,
            });
          },
        },
      ],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(
      rejection instanceof Error ? rejection.message : String(rejection),
    ).toContain("hold has no durable pending checkpoint");
    expect(harness.released()).toBe(true);
  });

  test("an ordinary repair failure still fails the online phase", async () => {
    const harness = createHarness();
    const rejection: unknown = await runOnlineMigrations(harness.pool, {
      repairs: [
        {
          introducedBy: "20261001123000_database_backfill_state",
          name: "failed-repair",
          readCompletion: async () => ({
            type: "incomplete",
            reason: "not attempted",
          }),
          repair: async () => {
            throw new TypeError("repair write failed");
          },
        },
      ],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(
      rejection instanceof Error ? rejection.message : String(rejection),
    ).toContain("repair write failed");
    expect(harness.released()).toBe(true);
  });

  test("validates empty fresh tables without waiting for a metric source", async () => {
    const harness = createHarness({
      emptyRepairTables: true,
      unvalidatedConstraints: [
        DECISION_DATE_CONSTRAINT,
        DELETE_RECEIPT_CONSTRAINT,
      ],
    });
    await runOnlineMigrations(harness.pool);
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(harness.statements, VALIDATE_DELETE_RECEIPT_FRAGMENT),
    ).toBeGreaterThan(-1);
    // Completion reads may inspect a prior checkpoint; fresh empty tables
    // validate without opening a batch or creating checkpoint state.
    expect(indexOfStatement(harness.statements, "BEGIN")).toBe(-1);
    expect(
      harness.statements.filter(
        (statement) =>
          statement.includes("database_backfill_states") &&
          !statement.startsWith("SELECT"),
      ),
    ).toEqual([]);
    expect(harness.released()).toBe(true);
  });

  test("skips a repair whose completion already holds", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    // Every repair reports itself complete, so none of them opens a
    // transaction: no walk over the intents, no decision-date selection, and
    // nothing revalidated.
    expect(indexOfStatement(harness.statements, "BEGIN")).toBe(-1);
    expect(
      indexOfStatement(
        harness.statements,
        'UPDATE public."corpus_index_projection_intents"',
      ),
    ).toBe(-1);
    expect(
      indexOfStatement(harness.statements, VALIDATE_DELETE_RECEIPT_FRAGMENT),
    ).toBe(-1);
    expect(
      indexOfStatement(harness.statements, "corrupt AS MATERIALIZED"),
    ).toBe(-1);
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("startup validation rejects an unvalidated delete-receipt constraint without repairing", async () => {
    const harness = createHarness({
      unvalidatedConstraints: [DELETE_RECEIPT_CONSTRAINT],
    });

    const rejection: unknown = await reportOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `Online repair corpus-projection-delete-receipt introduced by .* is not complete: constraint ${DELETE_RECEIPT_CONSTRAINT} is not validated`,
          "u",
        ),
      ),
    });
    expect(
      indexOfStatement(harness.statements, VALIDATE_DELETE_RECEIPT_FRAGMENT),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("startup validation rejects an unvalidated decision-date constraint without repairing", async () => {
    const harness = createHarness({
      unvalidatedConstraints: [DECISION_DATE_CONSTRAINT],
    });

    const rejection: unknown = await reportOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `Online repair decision-date-ceiling introduced by .* is not complete: constraint ${DECISION_DATE_CONSTRAINT} is not validated`,
          "u",
        ),
      ),
    });
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });
});

type IndexState =
  | boolean
  | undefined
  | { definitionBody: string; isValid: boolean }
  | { isReady: boolean; isValid: boolean };
type IndexStates = Readonly<Record<string, IndexState[]>>;
type Artifact = { isValid: boolean; name: string };
type Artifacts = Readonly<Record<string, Artifact[]>>;

type HarnessOptions = {
  newestAppliedMigration?: string;
  artifacts?: Artifacts;
  /**
   * Constraints `pg_constraint` reports as not validated until a repair's
   * VALIDATE statement runs; the rest are validated from the start.
   */
  unvalidatedConstraints?: readonly string[];
  emptyRepairTables?: boolean;
  timeoutRepairBatch?: boolean;
  indexStates?: IndexStates;
  /** Missing until their CREATE statement completes, independent of reads. */
  missingIndexes?: readonly string[];
  /** Replaced indexes already gone; the rest are present until dropped. */
  retiredIndexes?: readonly string[];
  /** Another session (a migrate run) holds the online lock. */
  onlineLockHeld?: boolean;
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const artifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const createHarness = ({
  newestAppliedMigration = "99999999999999_later_release",
  artifacts = {},
  unvalidatedConstraints = [],
  indexStates = {},
  missingIndexes = [],
  emptyRepairTables = false,
  timeoutRepairBatch = false,
  retiredIndexes = ONLINE_INDEX_REPLACEMENTS.map(
    ({ legacyName }) => legacyName,
  ),
  onlineLockHeld = false,
}: HarnessOptions = {}) => {
  const statements: string[] = [];
  const legacyIndexes = new Set(
    ONLINE_INDEX_REPLACEMENTS.map(({ legacyName }) => legacyName),
  );
  const droppedLegacyIndexes = new Set(
    retiredIndexes.filter((name) => indexStates[name] === undefined),
  );
  const backfillStates = new Map<
    unknown,
    { cursor: unknown; batch: unknown }
  >();
  const pendingConstraints = new Set(unvalidatedConstraints);
  const indexOffsets = new Map<string, number>();
  const pendingIndexes = new Set(missingIndexes);
  const remainingArtifacts = new Map(
    Object.entries(artifacts).map(([name, values]) => [name, [...values]]),
  );
  let released = false;
  const onlineIndexes = [
    ...ONLINE_MIGRATION_INDEXES,
    ...ONLINE_MIGRATION_INDEX_CUTOVERS.map(({ staged }) => staged),
  ];
  const retiredIndexDefinitions = ONLINE_INDEX_REPLACEMENTS.map(
    ({ legacyName, replacementNames }) => {
      const index = onlineIndexes.find(({ name }) =>
        replacementNames.includes(name),
      );
      if (!index) {
        throw new TypeError("Expected replacement index");
      }
      return { ...index, name: legacyName };
    },
  );
  const managedIndexes = [
    ...retiredIndexDefinitions,
    ...onlineIndexes,
    ...ONLINE_MIGRATION_INDEX_CUTOVERS.map(({ final }) => final),
  ];

  const queryBackfillCheckpoint = (
    query: string,
    params: readonly unknown[],
  ) => {
    if (query.startsWith("INSERT")) {
      const serialized = params.at(2);
      if (typeof serialized !== "string") {
        throw new TypeError("Expected checkpoint JSON");
      }
      const batch: unknown = JSON.parse(serialized);
      if (!backfillStates.has(params.at(0))) {
        backfillStates.set(params.at(0), {
          cursor: params.at(1),
          batch,
        });
      }
      return [];
    }
    if (query.startsWith("UPDATE")) {
      const serialized = params.at(2);
      if (typeof serialized !== "string") {
        throw new TypeError("Expected checkpoint JSON");
      }
      const batch: unknown = JSON.parse(serialized);
      backfillStates.set(params.at(0), { cursor: params.at(1), batch });
      return [];
    }
    return [backfillStates.get(params.at(0))];
  };

  const queryIndexArtifacts = (params: readonly unknown[]) => {
    const newPrefix = params.at(2);
    const oldPrefix = params.at(3);
    const index = managedIndexes.find(
      ({ name }) =>
        artifactPrefix(name, "_ccnew") === newPrefix &&
        artifactPrefix(name, "_ccold") === oldPrefix,
    );
    if (!index) {
      throw new TypeError("Expected managed index artifact prefixes");
    }
    return (remainingArtifacts.get(index.name) ?? []).map(({ isValid, name }) =>
      indexRow(index, isValid, name),
    );
  };

  const queryIndexState = (params: readonly unknown[]) => {
    const indexName = params.at(1);
    if (typeof indexName !== "string") {
      throw new TypeError("Expected index name query parameter");
    }
    if (legacyIndexes.has(indexName)) {
      return droppedLegacyIndexes.has(indexName)
        ? []
        : [
            {
              definition: `CREATE INDEX ${indexName} ON public.${String(params.at(2))} USING btree (id)`,
              isReady: true,
              isUnique: false,
              isValid: true,
              name: indexName,
            },
          ];
    }
    const index = managedIndexes.find(({ name }) => name === indexName);
    if (!index) {
      throw new TypeError("Expected managed index name");
    }
    if (pendingIndexes.has(indexName)) {
      return [];
    }
    const offset = indexOffsets.get(indexName) ?? 0;
    const states = indexStates[indexName];
    let state: IndexState =
      indexName === FILTER_INDEX_REPLACEMENT ? undefined : true;
    if (states) {
      state = offset < states.length ? states.at(offset) : states.at(-1);
    }
    indexOffsets.set(indexName, offset + 1);
    if (state === undefined) {
      return [];
    }
    if (typeof state === "boolean") {
      return [indexRow(index, state)];
    }
    if ("isReady" in state) {
      return [{ ...indexRow(index, state.isValid), isReady: state.isReady }];
    }
    return [indexRow(index, state.isValid, index.name, state.definitionBody)];
  };

  return {
    pool: {
      reserve: async () => ({
        execute: async (query: string) => {
          statements.push(query);
          for (const { name, createSql } of onlineIndexes) {
            if (query === createSql) {
              pendingIndexes.delete(name);
            }
          }
          for (const constraint of pendingConstraints) {
            if (query.includes(`VALIDATE CONSTRAINT "${constraint}"`)) {
              pendingConstraints.delete(constraint);
            }
          }
          if (!query.includes(DROP_INDEX_FRAGMENT)) {
            return;
          }
          for (const name of legacyIndexes) {
            if (query.includes(`"${name}"`)) {
              droppedLegacyIndexes.add(name);
            }
          }
          for (const [name, values] of remainingArtifacts) {
            remainingArtifacts.set(
              name,
              values.filter(
                ({ name: artifactName }) =>
                  !query.includes(`"${artifactName}"`),
              ),
            );
          }
        },
        query: async (query: string, params: readonly unknown[] = []) => {
          statements.push(`${query}\n-- params ${JSON.stringify(params)}`);
          if (query.includes("FROM drizzle.__drizzle_migrations")) {
            return [{ name: newestAppliedMigration }];
          }
          if (
            query.includes('AS "uniquePresent"') &&
            query.includes('AS "foreignReady"')
          ) {
            return [
              {
                indexReady: true,
                uniquePresent: true,
                uniqueReady: true,
                foreignPresent: true,
                foreignReady: true,
              },
            ];
          }
          if (query.includes("pg_backend_pid() AS pid")) {
            return [{ pid: 1, database: "test" }];
          }
          if (query.includes("pg_advisory_xact_lock")) {
            return [];
          }
          if (query.includes("pg_try_advisory_lock(hashtext('stella-online")) {
            return [{ acquired: !onlineLockHeld }];
          }
          if (query.includes("current_setting('statement_timeout')")) {
            return [{ timeout: SESSION_STATEMENT_TIMEOUT }];
          }
          if (
            query.includes(" AS acquired") ||
            query.includes("pg_try_advisory_lock") ||
            query.includes("pg_advisory_unlock") ||
            query.includes("pg_locks")
          ) {
            return [{ acquired: true }];
          }
          if (query.startsWith("SELECT set_config(")) {
            return [];
          }
          // The contact VAT ID repair's movable-contact probe: none left, so
          // its completion holds and the phase skips it.
          if (query.startsWith('SELECT 1 FROM public."contacts"')) {
            return [];
          }
          if (query.startsWith("SELECT 1 FROM public.chat_run_log_entries")) {
            return [];
          }
          if (query.startsWith("SELECT 1 FROM public.")) {
            return emptyRepairTables ? [] : [{ present: 1 }];
          }
          // The chat content repair's source and leftover reads: no chat
          // rows, so it goes straight to its validations.
          if (/^SELECT id FROM \w+ /u.test(query)) {
            return [];
          }
          if (
            query.trim() ===
            "SELECT to_regproc('public.entity_feature_gate_finish') IS NOT NULL AS installed"
          ) {
            return [{ installed: false }];
          }
          if (query.includes("database_backfill_states")) {
            return queryBackfillCheckpoint(query, params);
          }
          if (query.includes("pg_constraint")) {
            const constraintName = params.at(2);
            if (typeof constraintName !== "string") {
              throw new TypeError("Expected constraint name query parameter");
            }
            return [{ isValidated: !pendingConstraints.has(constraintName) }];
          }
          // This harness starts with invoice clients already backfilled.
          if (
            query.includes("FROM public.invoices i JOIN public.workspaces w")
          ) {
            return [];
          }
          // ...and with its invoices' sent markers and settling payments.
          if (
            query.includes("i.sent_at IS NULL") ||
            query.includes("FROM public.invoice_payments p")
          ) {
            return [];
          }
          // The decision-date repair's selection: nothing left to repair.
          if (query.includes("corrupt AS MATERIALIZED")) {
            if (timeoutRepairBatch) {
              throw new SQL.PostgresError("repair batch statement timeout", {
                code: "ERR_POSTGRES_SERVER_ERROR",
                errno: "57014",
                detail: "",
                hint: "",
                severity: "ERROR",
              });
            }
            return [];
          }
          // The delete-receipt repair's walk: no batch boundary left, so the
          // walk is on its last range.
          if (query.includes("corpus_index_projection_intents")) {
            return [];
          }
          // The OAuth-policy repair's completion census: a complete policy.
          // Checked before the table branch below, because the census names
          // both its own CTE and the tables.
          if (query.includes("expected_resource")) {
            return [
              {
                clientsLinked: true,
                linksUseConfiguredResources: true,
                resourcesMatch: true,
              },
            ];
          }
          // Its resource seed and its client walk: nothing stored yet, and no
          // registration to link, so both converge on the first pass.
          // The finding decision backfill's probe: no decided finding is
          // without history, so its completion holds.
          if (query.includes("document_review_finding_decisions event")) {
            return [];
          }
          if (
            query.includes("oauth_resource") ||
            query.includes("oauth_client")
          ) {
            return [];
          }
          if (query.includes("starts_with")) {
            return queryIndexArtifacts(params);
          }

          return queryIndexState(params);
        },
        terminate: async () => undefined,
        release: () => {
          released = true;
        },
      }),
    },
    released: () => released,
    statements,
  };
};

const indexRow = (
  index: (typeof ONLINE_MIGRATION_INDEXES)[number],
  isValid: boolean,
  name = index.name,
  body = index.definitionBody,
) => ({
  definition: `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${name} ${body}`,
  isReady: isValid,
  isUnique: index.isUnique,
  isValid,
  name,
});

const indexOfStatement = (statements: string[], fragment: string): number =>
  statements.findIndex((statement) => statement.includes(fragment));
