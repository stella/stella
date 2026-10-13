import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import {
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

describe.skipIf(!enabled)(
  "scoped owner organization isolation (postgres)",
  () => {
    test("actor scopes refresh the flow grant after revoke and regrant", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          const readFlowGrant = async () =>
            await withAggregateTransaction(db, async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: a.organizationId,
                featureId: "flows",
              });
              const scope = await proveOrgScope(tx, {
                table: "workspaces",
                where: eq(workspaces.id, a.workspaceId),
              });
              if (scope.isErr()) {
                panic("Fixture matter must have a scope");
              }
              return await withOrgScope({
                tx,
                scope: scope.value,
                actor: { type: "actor", userId: a.userId },
                fn: async (scopedTx) => {
                  const row = (
                    await scopedTx.execute<{ enabled: boolean }>(
                      sql`SELECT current_setting('app.enabled_features', true)::jsonb ? 'flows' AS enabled`,
                    )
                  ).at(0);
                  if (row === undefined) {
                    panic("Scoped feature setting must exist");
                  }
                  return row.enabled;
                },
              });
            });
          expect(await readFlowGrant()).toBe(true);
          await db
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, a.organizationId),
                eq(featureEnrolments.userId, a.userId),
                eq(featureEnrolments.featureId, "flows"),
              ),
            );
          expect(await readFlowGrant()).toBe(false);
          await db.insert(featureEnrolments).values({
            organizationId: a.organizationId,
            userId: a.userId,
            featureId: "flows",
          });
          expect(await readFlowGrant()).toBe(true);
        } finally {
          restoreRuntime();
          await a.cleanup();
        }
      });
    });

    test("an organization-scoped system writer retains other organizations' rows", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        try {
          await db.insert(flowDefinitions).values({
            id: definitionId,
            organizationId: b.organizationId,
            createdByUserId: b.userId,
            name: "Scoped receipt fixture",
            steps: [],
            trigger: {
              type: "file-upload",
              workspaceIds: null,
              fileExtensions: null,
            },
          });
          const before = await b.read();
          await withAggregateTransaction(db, async (tx) => {
            const scope = await proveOrgScope(tx, {
              table: "workspaces",
              where: eq(workspaces.id, a.workspaceId),
            });
            if (scope.isErr()) {
              panic("Fixture matter must have a scope");
            }
            await withOrgScope({
              tx,
              scope: scope.value,
              actor: { type: "system" },
              fn: async (scopedTx) => {
                expect(
                  (await scopedTx.execute(sql`SELECT current_user AS role`)).at(
                    0,
                  ),
                ).toMatchObject({ role: "stella_system" });
                expect(
                  await scopedTx
                    .update(flowRuns)
                    .set({ error: "Scoped fixture" })
                    .where(eq(flowRuns.id, b.runId))
                    .returning({ id: flowRuns.id }),
                ).toEqual([]);
                expect(
                  await scopedTx
                    .update(flowRuns)
                    .set({ error: "Scoped fixture" })
                    .where(eq(flowRuns.id, a.runId))
                    .returning({ id: flowRuns.id }),
                ).toEqual([{ id: a.runId }]);
              },
            });
          });
          expect(await b.read()).toEqual(before);
          expect((await a.read()).run?.error).toBe("Scoped fixture");
          expect(
            (
              await db.execute(
                sql`SELECT pg_has_role(current_user, 'stella_system', 'USAGE') AS inherited`,
              )
            ).at(0),
          ).toMatchObject({ inherited: false });
          const ownerWrite = await Result.tryPromise(
            async () =>
              await db.insert(flowUploadTriggerIntents).values({
                definitionId,
                organizationId: b.organizationId,
                workspaceId: b.workspaceId,
                entityId: b.taskEntityId,
              }),
          );
          expect(ownerWrite.isErr()).toBe(true);
          if (ownerWrite.isOk()) {
            panic("Owner receipt insertion must be refused");
          }
          expect(getPgErrorCode(ownerWrite.error)).toBe(
            PG_ERROR.INSUFFICIENT_PRIVILEGE,
          );

          const refused = await Result.tryPromise(
            async () =>
              await withAggregateTransaction(db, async (tx) => {
                const scope = await proveOrgScope(tx, {
                  table: "workspaces",
                  where: eq(workspaces.id, a.workspaceId),
                });
                if (scope.isErr()) {
                  panic("Fixture matter must have a scope");
                }
                await withOrgScope({
                  tx,
                  scope: scope.value,
                  actor: { type: "system" },
                  fn: async (scopedTx) => {
                    await scopedTx.insert(flowUploadTriggerIntents).values({
                      definitionId,
                      organizationId: b.organizationId,
                      workspaceId: b.workspaceId,
                      entityId: b.taskEntityId,
                    });
                  },
                });
              }),
          );
          expect(refused.isErr()).toBe(true);
          if (refused.isOk()) {
            panic("Receipt insertion must be refused");
          }
          expect(getPgErrorCode(refused.error)).toBe(
            PG_ERROR.INSUFFICIENT_PRIVILEGE,
          );
          expect(await b.read()).toEqual(before);
          expect(
            await db.$count(
              flowUploadTriggerIntents,
              eq(flowUploadTriggerIntents.definitionId, definitionId),
            ),
          ).toBe(0);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });
  },
);
