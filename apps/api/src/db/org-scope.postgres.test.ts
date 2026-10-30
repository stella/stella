import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  OrgScopeMismatch,
  OrgScopeRowAbsent,
  proveMattersOrgScope,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  workspaces,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionRecoveryGrantState } from "@/api/lib/db/recovery-bookkeeping/grant-state";
import { recordDeferredNoticeState } from "@/api/lib/db/recovery-bookkeeping/notices";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import { writeSearchBookkeeping } from "@/api/lib/db/recovery-bookkeeping/search";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/workspace-search-activity";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });
type GrantTransitionProof = Parameters<
  typeof transitionRecoveryGrantState
>[0]["tx"];
type RejectsGrantProof<T> = T extends GrantTransitionProof ? false : true;
true satisfies RejectsGrantProof<Transaction>;
true satisfies RejectsGrantProof<typeof rootDb>;

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

describe.skipIf(!enabled)(
  "scoped owner organization isolation (postgres)",
  () => {
    test("receipt helpers enter the locked source scope before their delegated mutation", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const sourceA = Bun.randomUUIDv7();
        const sourceB = Bun.randomUUIDv7();
        try {
          await db.insert(pendingScoutEmissions).values([
            {
              organizationId: a.organizationId,
              workspaceId: a.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceA,
            },
            {
              organizationId: b.organizationId,
              workspaceId: b.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceB,
            },
          ]);
          await db.transaction(async (tx) => {
            const proof = await proveOrgScope(tx, {
              table: "pendingScoutEmissions",
              where: sql`${and(
                eq(pendingScoutEmissions.organizationId, a.organizationId),
                eq(pendingScoutEmissions.sourceId, sourceA),
              )}`,
            });
            if (proof.isErr()) {
              return panic("Missing receipt scope fixture");
            }
            const operation = {
              type: "dequeue-scout" as const,
              tx,
              scope: proof.value,
              where: eq(pendingScoutEmissions.sourceId, sourceB),
            };
            await mutateRecoveryReceipt(operation);
          });
          expect(
            await db.$count(
              pendingScoutEmissions,
              eq(pendingScoutEmissions.sourceId, sourceB),
            ),
          ).toBe(1);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("notice bookkeeping retains rows outside its locked source scope", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        try {
          await db
            .update(flowRuns)
            .set({ status: "completed" })
            .where(eq(flowRuns.id, b.runId));
          await db.transaction(async (tx) => {
            const proof = await proveOrgScope(tx, {
              table: "workspaces",
              where: eq(workspaces.id, a.workspaceId),
            });
            if (proof.isErr()) {
              return panic("Missing notice source scope");
            }
            const operation = {
              type: "completion-notice-pending" as const,
              scope: proof.value,
              runId: b.runId,
              workspaceId: b.workspaceId,
            };
            await recordDeferredNoticeState(tx, operation);
          });
          expect((await b.read()).run?.recoveryState).toBeNull();
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("claim bookkeeping retains rows outside its locked source scope", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const sourceA = Bun.randomUUIDv7();
        const sourceB = Bun.randomUUIDv7();
        const initial = new Date("2026-01-01T12:00:00Z");
        try {
          await db.insert(pendingScoutEmissions).values([
            {
              organizationId: a.organizationId,
              workspaceId: a.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceA,
              nextAttemptAt: initial,
            },
            {
              organizationId: b.organizationId,
              workspaceId: b.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceB,
              nextAttemptAt: initial,
            },
          ]);
          await db.transaction(async (tx) => {
            const proof = await proveOrgScope(tx, {
              table: "pendingScoutEmissions",
              where: eq(pendingScoutEmissions.sourceId, sourceA),
            });
            if (proof.isErr()) {
              return panic("Missing claim source scope");
            }
            const operation = {
              type: "scout-retry" as const,
              tx,
              scope: proof.value,
              where: eq(pendingScoutEmissions.sourceId, sourceB),
              nextAttemptAt: new Date("2026-01-02T12:00:00Z"),
              lastError: "retry fixture",
            };
            await mutateRecoveryClaim(operation);
          });
          const rows = await db
            .select({ nextAttemptAt: pendingScoutEmissions.nextAttemptAt })
            .from(pendingScoutEmissions)
            .where(eq(pendingScoutEmissions.sourceId, sourceB));
          expect(rows).toEqual([{ nextAttemptAt: initial }]);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("grant bookkeeping retains rows outside its locked source scope", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const sourceA = Bun.randomUUIDv7();
        const sourceB = Bun.randomUUIDv7();
        try {
          await db.insert(pendingScoutEmissions).values([
            {
              organizationId: a.organizationId,
              workspaceId: a.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceA,
            },
            {
              organizationId: b.organizationId,
              workspaceId: b.workspaceId,
              sourceKind: "document-review",
              sourceId: sourceB,
            },
          ]);
          await db.transaction(async (tx) => {
            const proof = await proveOrgScope(tx, {
              table: "pendingScoutEmissions",
              where: eq(pendingScoutEmissions.sourceId, sourceA),
            });
            if (proof.isErr()) {
              return panic("Missing grant source scope");
            }
            await withOrgScope({
              tx,
              scope: proof.value,
              actor: { type: "system" },
              fn: async (_scopedTx, scoped) =>
                await transitionRecoveryGrantState({
                  type: "scout",
                  tx: scoped,
                  where: eq(pendingScoutEmissions.sourceId, sourceB),
                  options: { from: ["pending"], to: "awaiting_grant" },
                  log: { event: "scout.emission_awaiting_grant" },
                }),
            });
          });
          const rows = await db
            .select({ status: pendingScoutEmissions.status })
            .from(pendingScoutEmissions)
            .where(eq(pendingScoutEmissions.sourceId, sourceB));
          expect(rows).toEqual([{ status: "pending" }]);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("search bookkeeping retains rows outside its locked source scope", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const initial = new Date("2026-01-01T12:00:00Z");
        const activity = new Date("2026-01-02T12:00:00Z");
        try {
          await db
            .update(workspaces)
            .set({ lastActivityAt: activity })
            .where(eq(workspaces.id, b.workspaceId));
          await db.insert(workspaceSearchDocuments).values({
            workspaceId: b.workspaceId,
            organizationId: b.organizationId,
            updatedAt: initial,
          });
          await db.transaction(async (tx) => {
            const proof = await proveOrgScope(tx, {
              table: "workspaces",
              where: eq(workspaces.id, a.workspaceId),
            });
            if (proof.isErr()) {
              return panic("Missing search source scope");
            }
            const operation = {
              type: "sync-workspace-activity" as const,
              db: tx,
              scope: proof.value,
              workspaceId: b.workspaceId,
            };
            await writeSearchBookkeeping(operation);
          });
          expect(
            await db
              .select({ updatedAt: workspaceSearchDocuments.updatedAt })
              .from(workspaceSearchDocuments)
              .where(eq(workspaceSearchDocuments.workspaceId, b.workspaceId)),
          ).toEqual([{ updatedAt: initial }]);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("activity projection role updates only its locked source timestamp", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const sibling = createSafeId<"workspace">();
        const initial = new Date("2026-01-01T12:00:00Z");
        const activity = new Date("2026-01-02T12:00:00Z");
        try {
          await db.insert(workspaces).values({
            id: sibling,
            organizationId: a.organizationId,
            name: "Other matter",
            reference: sibling,
            lastActivityAt: activity,
          });
          await db
            .update(workspaces)
            .set({ lastActivityAt: activity })
            .where(eq(workspaces.id, a.workspaceId));
          await db.insert(workspaceSearchDocuments).values([
            {
              workspaceId: a.workspaceId,
              organizationId: a.organizationId,
              updatedAt: initial,
            },
            {
              workspaceId: b.workspaceId,
              organizationId: b.organizationId,
              updatedAt: initial,
            },
            {
              workspaceId: sibling,
              organizationId: a.organizationId,
              updatedAt: initial,
            },
          ]);
          const asProjectionRole = async (
            fn: (tx: Transaction) => Promise<unknown>,
          ) =>
            await db.transaction(async (tx) => {
              const proof = await proveOrgScope(tx, {
                table: "workspaces",
                where: eq(workspaces.id, a.workspaceId),
              });
              if (proof.isErr()) {
                return panic("Missing projection role fixture");
              }
              await tx.execute(
                sql`SELECT set_config('app.organization_id', ${proof.value.organizationId}, true), set_config('app.workspace_ids', ${`{${a.workspaceId}}`}, true)`,
              );
              await tx.execute(
                sql`SET LOCAL ROLE stella_workspace_search_activity`,
              );
              return await fn(tx);
            });
          for (const workspaceId of [b.workspaceId, sibling]) {
            expect(
              await asProjectionRole(
                async (tx) =>
                  await tx
                    .update(workspaceSearchDocuments)
                    .set({ updatedAt: activity })
                    .where(
                      eq(workspaceSearchDocuments.workspaceId, workspaceId),
                    )
                    .returning({
                      workspaceId: workspaceSearchDocuments.workspaceId,
                    }),
              ),
            ).toEqual([]);
          }
          const wrongValue = await Result.tryPromise(
            async () =>
              await asProjectionRole(
                async (tx) =>
                  await tx
                    .update(workspaceSearchDocuments)
                    .set({ updatedAt: new Date("2026-01-03T12:00:00Z") })
                    .where(
                      eq(workspaceSearchDocuments.workspaceId, a.workspaceId),
                    ),
              ),
          );
          expect(wrongValue.isErr()).toBe(true);
          if (wrongValue.isErr()) {
            expect(getPgErrorCode(wrongValue.error)).toBe(
              PG_ERROR.INSUFFICIENT_PRIVILEGE,
            );
          }
          const otherColumn = await Result.tryPromise(
            async () =>
              await asProjectionRole(
                async (tx) =>
                  await tx
                    .update(workspaceSearchDocuments)
                    .set({ title: "Changed title" })
                    .where(
                      eq(workspaceSearchDocuments.workspaceId, a.workspaceId),
                    ),
              ),
          );
          expect(otherColumn.isErr()).toBe(true);
          if (otherColumn.isErr()) {
            expect(getPgErrorCode(otherColumn.error)).toBe(
              PG_ERROR.INSUFFICIENT_PRIVILEGE,
            );
          }
          await db.transaction(
            async (tx) => await syncWorkspaceSearchActivity(a.workspaceId, tx),
          );
          expect(
            await db
              .select({ updatedAt: workspaceSearchDocuments.updatedAt })
              .from(workspaceSearchDocuments)
              .where(eq(workspaceSearchDocuments.workspaceId, a.workspaceId)),
          ).toEqual([{ updatedAt: activity }]);
          expect(
            await db
              .select({ updatedAt: workspaceSearchDocuments.updatedAt })
              .from(workspaceSearchDocuments)
              .where(eq(workspaceSearchDocuments.workspaceId, b.workspaceId)),
          ).toEqual([{ updatedAt: initial }]);
          expect(
            await db
              .select({ updatedAt: workspaceSearchDocuments.updatedAt })
              .from(workspaceSearchDocuments)
              .where(eq(workspaceSearchDocuments.workspaceId, sibling)),
          ).toEqual([{ updatedAt: initial }]);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

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

    test("a matter page proves one organization from every locked matter", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const secondMatterId = createSafeId<"workspace">();
        try {
          await db.insert(workspaces).values({
            id: secondMatterId,
            organizationId: a.organizationId,
            name: "Second matter",
            reference: secondMatterId,
          });
          await withAggregateTransaction(db, async (tx) => {
            const proof = await proveMattersOrgScope(tx, [
              secondMatterId,
              a.workspaceId,
              secondMatterId,
            ]);
            if (proof.isErr()) {
              panic("Matters of one organization must prove a scope");
            }
            expect(proof.value.organizationId).toBe(a.organizationId);
            expect(proof.value.workspaceIds.toSorted()).toEqual(
              [a.workspaceId, secondMatterId].toSorted(),
            );
          });
          await withAggregateTransaction(db, async (tx) => {
            const mixed = await proveMattersOrgScope(tx, [
              a.workspaceId,
              b.workspaceId,
            ]);
            expect(mixed.isErr()).toBe(true);
            if (mixed.isErr()) {
              expect(mixed.error).toBeInstanceOf(OrgScopeMismatch);
            }
            const missing = await proveMattersOrgScope(tx, [
              a.workspaceId,
              createSafeId<"workspace">(),
            ]);
            expect(missing.isErr()).toBe(true);
            if (missing.isErr()) {
              expect(missing.error).toBeInstanceOf(OrgScopeRowAbsent);
            }
            const empty = await proveMattersOrgScope(tx, []);
            expect(empty.isErr()).toBe(true);
          });
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });
  },
);
