import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestState } from "@stll/test-state";

import {
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  signals,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { DEFAULT_STATEMENT_CEILING } from "@/api/lib/db/statement-ceiling";
import { escapeLike } from "@/api/lib/escape-like";
import {
  RECOVERY_SCAN_IDENTITIES,
  RECOVERY_SCAN_PHASES,
} from "@/api/lib/scheduler/tasks/recovery-scan-identity";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withQueryPerfFixture } from "@/api/tests/query-perf/fixture";
import {
  RECOVERY_COHORT_SETUP,
  RECOVERY_READ_SIZES,
  type RecoveryJob,
  recoveryMeasurementRuns,
  type RecoveryScenario,
} from "@/api/tests/query-perf/registry";
import { measureScheduledJobRun } from "@/api/tests/query-perf/scheduled-run";

import type { QueryPerfDeadline } from "./deadline";
import { budgetProblem, scaleViolations } from "./measurement";
import {
  RECOVERY_ORGANIZATION_PREFIX,
  seedRecoveryScenario,
} from "./recovery-seed";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const testState = createTestState({ file: import.meta.path, config: env });
const NOW = new Date("2026-01-10T12:00:00.000Z");
const receiptCounts = async (
  database: Parameters<typeof seedRecoveryScenario>[0],
  kind: RecoveryJob,
) =>
  kind === "upload"
    ? await database
        .select({
          status: flowUploadTriggerIntents.status,
          rows: sql<number>`count(*)`.mapWith(Number),
        })
        .from(flowUploadTriggerIntents)
        .where(
          like(
            flowUploadTriggerIntents.organizationId,
            `${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`,
          ),
        )
        .groupBy(flowUploadTriggerIntents.status)
    : await database
        .select({
          status: pendingScoutEmissions.status,
          rows: sql<number>`count(*)`.mapWith(Number),
        })
        .from(pendingScoutEmissions)
        .where(
          like(
            pendingScoutEmissions.organizationId,
            `${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`,
          ),
        )
        .groupBy(pendingScoutEmissions.status);

const effectCount = async (
  database: Parameters<typeof seedRecoveryScenario>[0],
  kind: RecoveryJob,
) =>
  kind === "upload"
    ? await database
        .select({ rows: sql<number>`count(*)`.mapWith(Number) })
        .from(flowRuns)
        .innerJoin(
          flowDefinitions,
          eq(flowRuns.definitionId, flowDefinitions.id),
        )
        .where(
          like(
            flowDefinitions.organizationId,
            `${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`,
          ),
        )
        .then((rows) => rows.at(0)?.rows ?? 0)
    : await database
        .select({ rows: sql<number>`count(*)`.mapWith(Number) })
        .from(signals)
        .where(
          like(
            signals.organizationId,
            `${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`,
          ),
        )
        .then((rows) => rows.at(0)?.rows ?? 0);

const recoveryScenarios = recoveryMeasurementRuns()
  .filter(({ scenario }) => scenario.rows === RECOVERY_READ_SIZES[0])
  .map(({ scenario }) => scenario);

type MeasureRecoveryPhaseOptions = {
  database: Parameters<typeof seedRecoveryScenario>[0];
  deadline: QueryPerfDeadline;
  scenario: RecoveryScenario;
  phase: (typeof RECOVERY_SCAN_PHASES)[keyof typeof RECOVERY_SCAN_PHASES];
};
const measureRecoveryPhase = async ({
  database,
  deadline,
  scenario,
  phase,
}: MeasureRecoveryPhaseOptions) => {
  const measurement = RECOVERY_SCAN_IDENTITIES[scenario.job];
  const result = await deadline.run(
    `run ${phase} ${measurement.jobId} on ${scenario.cohort}:${scenario.rows}`,
    async () =>
      await measureScheduledJobRun({
        database,
        jobId: measurement.jobId,
        task: measurement.task,
        now: NOW,
      }),
  );
  expect(result.execution).toEqual({ type: "recovery", phase });
  expect(result.statementCounts.statements).toBe(
    result.executedStatements.length,
  );
  return result;
};

describe.skipIf(!enabled)("recovery read corpus (postgres)", () => {
  // timeout: production-size corpus seeding, VACUUM and native EXPLAIN share the existing corpus profile deadline.
  test.each(recoveryScenarios)(
    "measures both registered recovery phases for %j",
    async (scenario) => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL required for recovery read corpus");
      }
      const previousFlows = env.FEATURE_FLOWS;
      const previousSignals = env.FEATURE_SIGNALS;
      const previousDocumentScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      testState.setConfig("FEATURE_FLOWS", true);
      testState.setConfig("FEATURE_SIGNALS", true);
      testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
      try {
        const measureAtSize = async (rows: number) => {
          const sizeScenario = { ...scenario, rows };
          return await withQueryPerfFixture({
            databaseUrl,
            profileId: "corpus",
            timeoutMs: 300_000,
            run: async (database, deadline) => {
              await deadline.run(
                `seed ${sizeScenario.job}:${sizeScenario.cohort}:${rows}`,
                async () => await seedRecoveryScenario(database, sizeScenario),
              );
              const before = await receiptCounts(database, sizeScenario.job);
              expect(before).toEqual([
                {
                  status:
                    RECOVERY_COHORT_SETUP[sizeScenario.cohort].initialStatus,
                  rows,
                },
              ]);

              const census = await measureRecoveryPhase({
                database,
                deadline,
                scenario: sizeScenario,
                phase: RECOVERY_SCAN_PHASES.census,
              });
              const dispatch = await measureRecoveryPhase({
                database,
                deadline,
                scenario: sizeScenario,
                phase: RECOVERY_SCAN_PHASES.dispatch,
              });
              const phaseMeasurements = [
                { phase: "census", result: census },
                { phase: "dispatch", result: dispatch },
              ] as const;
              for (const { result } of phaseMeasurements) {
                expect(
                  result.statementCounts.statements +
                    result.statementCounts.transactionRoundTrips,
                ).toBeLessThanOrEqual(DEFAULT_STATEMENT_CEILING);
              }

              const after = await receiptCounts(database, sizeScenario.job);
              const effects = await effectCount(database, sizeScenario.job);
              for (const { phase, result } of phaseMeasurements) {
                process.stdout.write(
                  `${JSON.stringify({
                    event: "recovery_read_measurement",
                    phase,
                    scenario: sizeScenario,
                    before,
                    after,
                    effects,
                    statementCounts: result.statementCounts,
                    metrics: result.metrics,
                    statements: result.statements.map(
                      ({ metrics, statement }) => ({ metrics, statement }),
                    ),
                  })}\n`,
                );
              }

              const totalReceipts = after.reduce(
                (total, state) => total + state.rows,
                0,
              );
              if (sizeScenario.cohort === "quiet") {
                expect(after).toEqual([{ status: "pending", rows }]);
                expect(effects).toBe(0);
              } else if (sizeScenario.cohort === "pending") {
                expect(totalReceipts).toBe(rows);
                const awaiting =
                  after.find(({ status }) => status === "awaiting_grant")
                    ?.rows ?? 0;
                expect(awaiting).toBeGreaterThan(0);
                expect(awaiting).toBeLessThanOrEqual(
                  sizeScenario.job === "upload" ? 32 : 100,
                );
                expect(effects).toBe(0);
              } else if (sizeScenario.cohort === "grant-repair") {
                expect(totalReceipts).toBeLessThan(rows);
                expect(effects).toBeGreaterThan(0);
                expect(effects).toBeLessThanOrEqual(
                  sizeScenario.job === "upload" ? 32 : 100,
                );
              } else {
                expect(totalReceipts).toBe(rows);
                expect(after).toEqual([{ status: "awaiting_grant", rows }]);
                expect(effects).toBe(0);
              }
              return { census, dispatch };
            },
          });
        };
        const oneSize = await measureAtSize(RECOVERY_READ_SIZES[0]);
        const doubleSize = await measureAtSize(RECOVERY_READ_SIZES[1]);

        for (const phase of ["census", "dispatch"] as const) {
          for (const result of [oneSize[phase], doubleSize[phase]]) {
            expect(
              budgetProblem(result.budgetId, result.metrics),
            ).toBeUndefined();
            expect(result.planViolations).toEqual([]);
          }
          expect(
            oneSize[phase].statementCounts,
            `${phase} statement counts changed at twice the corpus size`,
          ).toEqual(doubleSize[phase].statementCounts);
          expect(
            scaleViolations({
              size: oneSize[phase].metrics.sharedBlocks,
              double: doubleSize[phase].metrics.sharedBlocks,
            }),
            `${phase} reads grew with the corpus`,
          ).toEqual([]);
        }
      } finally {
        testState.setConfig("FEATURE_FLOWS", previousFlows);
        testState.setConfig("FEATURE_SIGNALS", previousSignals);
        testState.setConfig(
          "FEATURE_INBOX_DOCUMENT_SCOUTS",
          previousDocumentScouts,
        );
        restoreMode();
      }
    },
    300_000,
  ); // timeout: each paired case seeds and measures two fresh 60,000- and 120,000-row clones within the unchanged corpus deadline.
});
