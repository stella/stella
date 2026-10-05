import { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";

import { PROVISION_STATE_BACKFILL_STEPS } from "@/api/lib/case-law/provision-state-backfill/backfill";

import { readOnlineIndexConfig } from "../env-online-index";
import { BackfillHeldError } from "./backfill-runtime";
import { createDecisionDateCeilingRepair } from "./decision-date-ceiling-repair";
import { createOnlineIndexHold } from "./online-index-gate";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import {
  assertOnlineMigrationsApplied,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
  runOnlineMigrations as runOnlineMigrationsWithGate,
  type OnlineRepairOptions,
} from "./online-migrations";
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
const runOnlineMigrations = async (
  pool: Parameters<typeof runOnlineMigrationsWithGate>[0],
  options: Partial<OnlineRepairOptions> = {},
) =>
  await runOnlineMigrationsWithGate(pool, {
    indexGate: healthyIndexGate,
    ...options,
    reserveObserver: async () => ({
      execute: async () => undefined,
      query: async (query) => {
        if (query.includes("pg_backend_pid() AS pid")) {
          return [{ pid: 2, database: "test" }];
        }
        if (query.includes("ageMs")) {
          return [
            { ageMs: 0, observedAt: new Date(testClock()).toISOString() },
          ];
        }
        return [
          { active: false, observedAt: new Date(testClock()).toISOString() },
        ];
      },
      release: () => undefined,
    }),
  });

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
const CLEANUP_STALL_CONSTRAINTS = [
  "corpus_index_projection_intents_status_values",
  "corpus_index_projection_intents_status_shape",
  "corpus_index_projection_intents_delete_reissues_nonnegative",
] as const;

describe("online migrations", () => {
  /**
   * The online phase runs inside the migrator's exclusive corpus schema lane,
   * so a walk or a full-table scan there pauses every corpus writer for its
   * whole length. The provision state backfill is a scheduler job instead.
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

  test.each(SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS)(
    "validates monitoring constraint $name once and rejects incomplete startup",
    async ({ name }) => {
      const harness = createHarness({ unvalidatedConstraints: [name] });
      const rejection = await assertOnlineMigrationsApplied(harness.pool).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toMatchObject({
        message: `Online repair ${name} is not complete: constraint ${name} is not validated`,
      });
      const beforeRepair = harness.statements.length;
      await runOnlineMigrations(harness.pool);
      await assertOnlineMigrationsApplied(harness.pool);
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

  test("accepts an already valid index without rebuilding it", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("creates a missing index online and verifies completion", async () => {
    const harness = createHarness({
      missingIndexes: [REPORT_EXPORT_INDEX],
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  /**
   * The migrator runs this phase holding the exclusive corpus schema lane, so
   * a gate that sleeps until health returns pauses every corpus writer for
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
      index: REPORT_EXPORT_INDEX,
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
          index: staged.name,
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
        index: REPORT_EXPORT_INDEX,
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

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} is not ready`,
    });
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
  });

  test("retires a legacy index only after both replacements validate", async () => {
    const harness = createHarness();

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
    const harness = createHarness();

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
      unvalidatedConstraints: [DECISION_DATE_CONSTRAINT],
    });
    const pending: unknown[] = [];
    await runOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    await assertOnlineMigrationsApplied(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    expect(pending).toHaveLength(2);
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
    await assertOnlineMigrationsApplied(harness.pool);

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

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Online repair corpus-projection-cleanup-stall is not complete: constraint ${constraint} is not validated`,
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
      unvalidatedConstraints: [DELETE_RECEIPT_CONSTRAINT],
    });
    const pending: unknown[] = [];
    await runOnlineMigrations(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    await assertOnlineMigrationsApplied(harness.pool, {
      log: (record) => {
        pending.push(record);
      },
    });
    expect(pending).toHaveLength(2);
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

  test("a migrate-phase batch statement timeout stays pending and deployment proceeds", async () => {
    const harness = createHarness({
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
    await assertOnlineMigrationsApplied(harness.pool, {
      repairs: [repair],
      log: (record) => {
        pending.push(record);
      },
    });
    expect(pending).toHaveLength(2);
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

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Online repair corpus-projection-delete-receipt is not complete: constraint ${DELETE_RECEIPT_CONSTRAINT} is not validated`,
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

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Online repair decision-date-ceiling is not complete: constraint ${DECISION_DATE_CONSTRAINT} is not validated`,
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
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const artifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const createHarness = ({
  artifacts = {},
  unvalidatedConstraints = [],
  indexStates = {},
  missingIndexes = [],
  emptyRepairTables = false,
  timeoutRepairBatch = false,
}: HarnessOptions = {}) => {
  const statements: string[] = [];
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
  const managedIndexes = [
    ...onlineIndexes,
    ...ONLINE_MIGRATION_INDEX_CUTOVERS.map(({ final }) => final),
  ];

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
          if (query.includes("pg_backend_pid() AS pid")) {
            return [{ pid: 1, database: "test" }];
          }
          if (query.includes("pg_advisory_xact_lock")) {
            return [];
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
          if (query.startsWith("SELECT 1 FROM public.")) {
            return emptyRepairTables ? [] : [{ present: 1 }];
          }
          if (query.includes("database_backfill_states")) {
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
          }
          if (query.includes("pg_constraint")) {
            const constraintName = params.at(2);
            if (typeof constraintName !== "string") {
              throw new TypeError("Expected constraint name query parameter");
            }
            return [{ isValidated: !pendingConstraints.has(constraintName) }];
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
          if (
            query.includes("oauth_resource") ||
            query.includes("oauth_client")
          ) {
            return [];
          }
          if (query.includes("starts_with")) {
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
            return (remainingArtifacts.get(index.name) ?? []).map(
              ({ isValid, name }) => indexRow(index, isValid, name),
            );
          }

          const indexName = params.at(1);
          if (typeof indexName !== "string") {
            throw new TypeError("Expected index name query parameter");
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
            return [
              { ...indexRow(index, state.isValid), isReady: state.isReady },
            ];
          }
          return [
            indexRow(index, state.isValid, index.name, state.definitionBody),
          ];
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
