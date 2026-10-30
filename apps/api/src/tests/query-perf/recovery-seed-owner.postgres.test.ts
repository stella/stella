import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
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
import { executedRows } from "@/api/lib/db/executed-rows";
import { escapeLike } from "@/api/lib/escape-like";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withQueryPerfFixture } from "@/api/tests/query-perf/fixture";
import { queryPerfDatabaseName } from "@/api/tests/query-perf/profiles";
import { measureScheduledJobRunRaw } from "@/api/tests/query-perf/scheduled-run";

import {
  cleanupRecoveryScenarios,
  RECOVERY_ORGANIZATION_PREFIX,
  RECOVERY_USER_PREFIX,
  seedRecoveryScenario,
} from "./recovery-seed";
import {
  RECOVERY_READ_SIZES,
  recoveryMeasurementRuns,
  type RecoveryScenario,
} from "./registry";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const testState = createTestState({ file: import.meta.path, config: env });
const NOW = new Date("2026-01-10T12:00:00.000Z");

class FixtureProbeFailure extends TaggedError("FixtureProbeFailure")<{
  message: string;
}> {}

const recoveryFixtureCounts = async (
  database: Parameters<typeof seedRecoveryScenario>[0],
) => {
  const organizationPattern = `${escapeLike(`${RECOVERY_ORGANIZATION_PREFIX}-`)}%`;
  const userPattern = `${escapeLike(`${RECOVERY_USER_PREFIX}-`)}%`;
  return (
    executedRows(
      await database.execute(sql`
    SELECT
      (SELECT count(*)::integer FROM organization WHERE id LIKE ${organizationPattern}) AS organizations,
      (SELECT count(*)::integer FROM "user" WHERE id LIKE ${userPattern}) AS users,
      (SELECT count(*)::integer FROM member WHERE organization_id LIKE ${organizationPattern}) AS members,
      (SELECT count(*)::integer FROM feature_enrolments WHERE organization_id LIKE ${organizationPattern}) AS feature_enrolments,
      (SELECT count(*)::integer FROM workspaces WHERE organization_id LIKE ${organizationPattern}) AS workspaces,
      (SELECT count(*)::integer FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id LIKE ${organizationPattern}) AS workspace_members,
      (SELECT count(*)::integer FROM entities e JOIN workspaces w ON w.id = e.workspace_id WHERE w.organization_id LIKE ${organizationPattern}) AS entities,
      (SELECT count(*)::integer FROM entity_versions v JOIN workspaces w ON w.id = v.workspace_id WHERE w.organization_id LIKE ${organizationPattern}) AS entity_versions,
      (SELECT count(*)::integer FROM fields f JOIN workspaces w ON w.id = f.workspace_id WHERE w.organization_id LIKE ${organizationPattern}) AS fields,
      (SELECT count(*)::integer FROM properties p JOIN workspaces w ON w.id = p.workspace_id WHERE w.organization_id LIKE ${organizationPattern}) AS properties,
      (SELECT count(*)::integer FROM flow_definitions WHERE organization_id LIKE ${organizationPattern}) AS flow_definitions,
      (SELECT count(*)::integer FROM flow_upload_trigger_intents WHERE organization_id LIKE ${organizationPattern}) AS flow_upload_trigger_intents,
      (SELECT count(*)::integer FROM document_review_runs WHERE organization_id LIKE ${organizationPattern}) AS document_review_runs,
      (SELECT count(*)::integer FROM document_review_findings WHERE organization_id LIKE ${organizationPattern}) AS document_review_findings,
      (SELECT count(*)::integer FROM pending_scout_emissions WHERE organization_id LIKE ${organizationPattern}) AS pending_scout_emissions
  `),
    ).at(0) ?? panic("Recovery fixture counts are missing")
  );
};

describe.skipIf(!enabled)("query perf fixture ownership (postgres)", () => {
  test("drops its isolated clone after the profile callback fails", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required for query perf fixture ownership");
    }
    const fixtureName = queryPerfDatabaseName("corpus");
    const failure = new FixtureProbeFailure({
      message: "fixture cleanup probe",
    });
    let reachedClone = false;
    expect(
      await rejectionOf(
        withQueryPerfFixture({
          databaseUrl,
          profileId: "corpus",
          timeoutMs: 300_000,
          run: async (database) => {
            expect(
              executedRows(
                await database.execute(sql`SELECT current_database() AS name`),
              ),
            ).toEqual([{ name: fixtureName }]);
            reachedClone = true;
            throw failure;
          },
        }),
      ),
    ).toBe(failure);
    expect(reachedClone).toBe(true);

    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    await withGatedTestClients(
      adminUrl.toString(),
      async ({ openClient }) => {
        const { db } = openClient();
        expect(
          executedRows(
            await db.execute(
              sql`SELECT datname FROM pg_database WHERE datname = ${fixtureName}`,
            ),
          ),
        ).toEqual([]);
      },
      { closeMode: "force" },
    );
  });

  test("recovers an enrolled upload receipt through its registered job", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required for query perf fixture ownership");
    }
    const scenario = {
      type: "recovery",
      job: "upload",
      cohort: "grant-repair",
      rows: 24,
    } satisfies RecoveryScenario;
    const previousFlows = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    try {
      await withQueryPerfFixture({
        databaseUrl,
        profileId: "corpus",
        timeoutMs: 300_000,
        run: async (database) => {
          await seedRecoveryScenario(database, scenario);
          const organizationPattern = `${escapeLike(
            `${RECOVERY_ORGANIZATION_PREFIX}-`,
          )}%`;
          const beforeReceipts = await database
            .select({ rows: sql<number>`count(*)`.mapWith(Number) })
            .from(flowUploadTriggerIntents)
            .where(
              like(
                flowUploadTriggerIntents.organizationId,
                organizationPattern,
              ),
            );
          expect(beforeReceipts.at(0)?.rows).toBe(scenario.rows);
          const beforeRuns = await database
            .select({ rows: sql<number>`count(*)`.mapWith(Number) })
            .from(flowRuns)
            .innerJoin(
              flowDefinitions,
              eq(flowRuns.definitionId, flowDefinitions.id),
            )
            .where(like(flowDefinitions.organizationId, organizationPattern));
          expect(beforeRuns.at(0)?.rows).toBe(0);

          const measurement =
            recoveryMeasurementRuns().find(
              ({ scenario: registered }) =>
                registered.job === scenario.job &&
                registered.cohort === scenario.cohort,
            ) ?? panic("Missing registered upload recovery measurement");
          const census = await measureScheduledJobRunRaw({
            database,
            jobId: measurement.jobId,
            task: measurement.task,
            now: NOW,
          });
          expect(
            census.statementCounts.statements +
              census.statementCounts.transactionRoundTrips,
          ).toBeLessThanOrEqual(100);
          expect(
            (
              await database
                .select({ rows: sql<number>`count(*)`.mapWith(Number) })
                .from(flowRuns)
                .innerJoin(
                  flowDefinitions,
                  eq(flowRuns.definitionId, flowDefinitions.id),
                )
                .where(
                  like(flowDefinitions.organizationId, organizationPattern),
                )
            ).at(0)?.rows,
          ).toBe(0);
          const dispatch = await measureScheduledJobRunRaw({
            database,
            jobId: measurement.jobId,
            task: measurement.task,
            now: NOW,
          });
          expect(
            dispatch.statementCounts.statements +
              dispatch.statementCounts.transactionRoundTrips,
          ).toBeLessThanOrEqual(100);
          expect({
            census: census.statementCounts,
            dispatch: dispatch.statementCounts,
          }).toEqual({
            census: { statements: 17, transactionRoundTrips: 6 },
            dispatch: { statements: 72, transactionRoundTrips: 16 },
          });

          const afterReceipts = await database
            .select({ rows: sql<number>`count(*)`.mapWith(Number) })
            .from(flowUploadTriggerIntents)
            .where(
              like(
                flowUploadTriggerIntents.organizationId,
                organizationPattern,
              ),
            );
          expect(afterReceipts.at(0)?.rows).toBe(scenario.rows - 1);
          const afterRuns = await database
            .select({ rows: sql<number>`count(*)`.mapWith(Number) })
            .from(flowRuns)
            .innerJoin(
              flowDefinitions,
              eq(flowRuns.definitionId, flowDefinitions.id),
            )
            .where(like(flowDefinitions.organizationId, organizationPattern));
          expect(afterRuns.at(0)?.rows).toBe(1);
        },
      });
    } finally {
      testState.setConfig("FEATURE_FLOWS", previousFlows);
      restoreMode();
    }
  });

  test("recovers one dense scout source through its registered job", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required for query perf fixture ownership");
    }
    const firstSize =
      RECOVERY_READ_SIZES.at(0) ?? panic("Recovery read sizes are empty");
    const measurement =
      recoveryMeasurementRuns().find(
        ({ scenario }) =>
          scenario.job === "scout" &&
          scenario.cohort === "grant-repair" &&
          scenario.rows === firstSize,
      ) ?? panic("Missing canonical scout grant-repair measurement");
    const scenario = { ...measurement.scenario, rows: 24 };
    const previousSignals = env.FEATURE_SIGNALS;
    const previousDocumentScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_SIGNALS", true);
    testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
    try {
      await withQueryPerfFixture({
        databaseUrl,
        profileId: "corpus",
        timeoutMs: 300_000,
        run: async (database) => {
          await seedRecoveryScenario(database, scenario);
          const organizationPattern = `${escapeLike(
            `${RECOVERY_ORGANIZATION_PREFIX}-`,
          )}%`;
          const receiptCount = async () =>
            (
              await database
                .select({ rows: sql<number>`count(*)`.mapWith(Number) })
                .from(pendingScoutEmissions)
                .where(
                  like(
                    pendingScoutEmissions.organizationId,
                    organizationPattern,
                  ),
                )
            ).at(0)?.rows ?? panic("Scout receipt count is missing");
          const signalCount = async () =>
            (
              await database
                .select({ rows: sql<number>`count(*)`.mapWith(Number) })
                .from(signals)
                .where(like(signals.organizationId, organizationPattern))
            ).at(0)?.rows ?? panic("Scout signal count is missing");

          expect(await receiptCount()).toBe(24);
          expect(await signalCount()).toBe(0);
          const census = await measureScheduledJobRunRaw({
            database,
            jobId: measurement.jobId,
            task: measurement.task,
            now: NOW,
          });
          expect(census.statementCounts).toEqual({
            statements: 16,
            transactionRoundTrips: 6,
          });
          expect(await signalCount()).toBe(0);

          const dispatch = await measureScheduledJobRunRaw({
            database,
            jobId: measurement.jobId,
            task: measurement.task,
            now: NOW,
          });
          expect(dispatch.statementCounts).toEqual({
            statements: 41,
            transactionRoundTrips: 6,
          });
          expect(await receiptCount()).toBe(23);
          expect(await signalCount()).toBe(1);
        },
      });
    } finally {
      testState.setConfig("FEATURE_SIGNALS", previousSignals);
      testState.setConfig(
        "FEATURE_INBOX_DOCUMENT_SCOUTS",
        previousDocumentScouts,
      );
      restoreMode();
    }
  });

  test("deletes the real 24-row scout fixture inside its disposable clone", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required for query perf fixture ownership");
    }
    const scenario = {
      type: "recovery",
      job: "scout",
      cohort: "quiet",
      rows: 24,
    } satisfies RecoveryScenario;
    await withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      timeoutMs: 300_000,
      run: async (database) => {
        await seedRecoveryScenario(database, scenario);
        expect(await recoveryFixtureCounts(database)).toEqual({
          organizations: 3,
          users: 3,
          members: 3,
          feature_enrolments: 3,
          workspaces: 12,
          workspace_members: 12,
          entities: 24,
          entity_versions: 24,
          fields: 24,
          properties: 12,
          flow_definitions: 0,
          flow_upload_trigger_intents: 0,
          document_review_runs: 24,
          document_review_findings: 24,
          pending_scout_emissions: 24,
        });

        const deleted = await cleanupRecoveryScenarios(database);
        expect(deleted.get("document_review_findings")).toBe(24);
        expect(deleted.get("fields")).toBe(24);
        expect(deleted.get("entity_versions")).toBe(24);
        expect(deleted.get("entities")).toBe(24);
        expect(deleted.get("organizations")).toBe(3);
        expect(deleted.get("users")).toBe(3);
        expect(await recoveryFixtureCounts(database)).toEqual({
          organizations: 0,
          users: 0,
          members: 0,
          feature_enrolments: 0,
          workspaces: 0,
          workspace_members: 0,
          entities: 0,
          entity_versions: 0,
          fields: 0,
          properties: 0,
          flow_definitions: 0,
          flow_upload_trigger_intents: 0,
          document_review_runs: 0,
          document_review_findings: 0,
          pending_scout_emissions: 0,
        });
      },
    });
  });
});
