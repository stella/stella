import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { recoverScoutEmission } from "./scout-emission-recovery";
import {
  recoverUploadFlowTriggerIntents,
  resumeUploadTriggersAfterGrant,
} from "./upload-flow-trigger-recovery";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const NOW = new Date("2030-01-01T12:00:00.000Z");
const LATER = new Date("2030-01-01T12:10:00.000Z");
const TRIGGER_CHANGES = [
  "manual",
  "workspace",
  "extension",
  "disabled",
  "unchanged",
] as const;
type TriggerChange = (typeof TRIGGER_CHANGES)[number];

const uploadFixture = async (db: GatedTestDb) =>
  await db.transaction(async (tx) => {
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const otherWorkspaceId = createSafeId<"workspace">();
    const definitionId = createSafeId<"flowDefinition">();
    const entityId = createSafeId<"entity">();
    await tx.insert(organization).values({
      id: organizationId,
      name: "Upload race fixture",
      slug: organizationId,
      createdAt: NOW,
    });
    await tx.insert(user).values({
      id: userId,
      name: "Upload author",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await tx.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: NOW,
    });
    await tx
      .insert(featureEnrolments)
      .values({ organizationId, userId, featureId: "flows" });
    await tx.insert(workspaces).values([
      {
        id: workspaceId,
        organizationId,
        name: "Upload matter",
        reference: workspaceId,
      },
      {
        id: otherWorkspaceId,
        organizationId,
        name: "Other matter",
        reference: otherWorkspaceId,
      },
    ]);
    await tx.insert(workspaceMembers).values({ workspaceId, userId });
    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      name: "receipt.pdf",
      createdBy: userId,
    });
    await tx.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Upload flow",
      enabled: true,
      createdByUserId: userId,
      steps: [
        {
          kind: "ai",
          name: "Draft",
          prompt: "Draft.",
          includeDocuments: false,
        },
      ],
      trigger: {
        type: "file-upload",
        workspaceIds: [workspaceId],
        fileExtensions: ["pdf"],
      },
    });
    await tx.insert(flowUploadTriggerIntents).values({
      definitionId,
      entityId,
      organizationId,
      workspaceId,
      fileExtension: "pdf",
      retryAt: NOW,
    });
    return {
      organizationId,
      userId,
      workspaceId,
      otherWorkspaceId,
      definitionId,
      entityId,
    };
  });

type ChangeTriggerOptions = {
  db: GatedTestDb;
  fixture: Awaited<ReturnType<typeof uploadFixture>>;
  change: TriggerChange;
};

const changeTrigger = async ({
  db,
  fixture,
  change,
}: ChangeTriggerOptions): Promise<void> => {
  switch (change) {
    case "manual":
      await db
        .update(flowDefinitions)
        .set({ trigger: { type: "manual" } })
        .where(eq(flowDefinitions.id, fixture.definitionId));
      break;
    case "workspace":
      await db
        .update(flowDefinitions)
        .set({
          trigger: {
            type: "file-upload",
            workspaceIds: [fixture.otherWorkspaceId],
            fileExtensions: ["pdf"],
          },
        })
        .where(eq(flowDefinitions.id, fixture.definitionId));
      break;
    case "extension":
      await db
        .update(flowDefinitions)
        .set({
          trigger: {
            type: "file-upload",
            workspaceIds: [fixture.workspaceId],
            fileExtensions: ["docx"],
          },
        })
        .where(eq(flowDefinitions.id, fixture.definitionId));
      break;
    case "disabled":
      await db
        .update(flowDefinitions)
        .set({ enabled: false })
        .where(eq(flowDefinitions.id, fixture.definitionId));
      break;
    case "unchanged":
      break;
    default:
      change satisfies never;
      return panic("Unknown upload trigger change");
  }
};

describe.skipIf(!enabled)("upload trigger commit admission (postgres)", () => {
  test("grant repair and eligible dispatch survive an older blocked receipt prefix", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const { db } = openClient();
          const blocked = await uploadFixture(db);
          const admitted = await uploadFixture(db);
          try {
            await db
              .delete(featureEnrolments)
              .where(
                eq(featureEnrolments.organizationId, blocked.organizationId),
              );
            const older = new Date(NOW.getTime() - 60_000);
            const extraEntities = Array.from({ length: 99 }, () => ({
              id: createSafeId<"entity">(),
              workspaceId: blocked.workspaceId,
              name: "blocked.pdf",
              createdBy: blocked.userId,
            }));
            await db.insert(entities).values(extraEntities);
            await db.insert(flowUploadTriggerIntents).values(
              extraEntities.map(({ id }) => ({
                definitionId: blocked.definitionId,
                entityId: id,
                organizationId: blocked.organizationId,
                workspaceId: blocked.workspaceId,
                fileExtension: "pdf",
                retryAt: older,
              })),
            );
            await db
              .update(flowUploadTriggerIntents)
              .set({ retryAt: older })
              .where(eq(flowUploadTriggerIntents.entityId, blocked.entityId));
            await db
              .update(flowUploadTriggerIntents)
              .set({ status: "awaiting_grant", retryAt: LATER })
              .where(eq(flowUploadTriggerIntents.entityId, admitted.entityId));
            const started: string[] = [];
            const recover = async (entityId?: typeof blocked.entityId) =>
              await recoverUploadFlowTriggerIntents({
                database: asTestRaw<SchedulerDb>(db),
                now: NOW,
                entityId,
                start: async ({ definitionId }) => {
                  started.push(definitionId);
                  return { status: "settled" };
                },
              });

            await recover();
            expect(started).toEqual([admitted.definitionId]);
            expect(
              await db.$count(
                flowUploadTriggerIntents,
                eq(
                  flowUploadTriggerIntents.organizationId,
                  blocked.organizationId,
                ),
              ),
            ).toBe(100);
            expect(
              await db.$count(
                flowUploadTriggerIntents,
                and(
                  eq(
                    flowUploadTriggerIntents.organizationId,
                    blocked.organizationId,
                  ),
                  eq(flowUploadTriggerIntents.status, "awaiting_grant"),
                ),
              ),
            ).toBe(32);

            await db.insert(featureEnrolments).values({
              organizationId: blocked.organizationId,
              userId: blocked.userId,
              featureId: "flows",
            });
            await db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx: asTestRaw<
                  Parameters<typeof lockFeatureRecoveryAdmission>[0]["tx"]
                >(tx),
                organizationId: blocked.organizationId,
                featureId: "flows",
              });
              await resumeUploadTriggersAfterGrant({
                tx: asTestRaw<
                  Parameters<typeof resumeUploadTriggersAfterGrant>[0]["tx"]
                >(tx),
                organizationId: blocked.organizationId,
                userId: blocked.userId,
                now: new Date(),
              });
            });
            expect(
              await db.$count(
                flowUploadTriggerIntents,
                and(
                  eq(
                    flowUploadTriggerIntents.organizationId,
                    blocked.organizationId,
                  ),
                  eq(flowUploadTriggerIntents.status, "awaiting_grant"),
                ),
              ),
            ).toBe(0);
            await recover(blocked.entityId);
            expect(started).toEqual([
              admitted.definitionId,
              blocked.definitionId,
            ]);
          } finally {
            for (const fixture of [blocked, admitted]) {
              await db
                .delete(organization)
                .where(eq(organization.id, fixture.organizationId));
              await db.delete(user).where(eq(user.id, fixture.userId));
            }
          }
        },
      );
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restoreMode();
    }
  });

  test("missing review sources settle beyond a blocked prefix and an awaiting-grant repair", async () => {
    const previousSignals = env.FEATURE_SIGNALS;
    const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_SIGNALS = true;
    env.FEATURE_INBOX_DOCUMENT_SCOUTS = true;
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const { db } = openClient();
          const fixture = await uploadFixture(db);
          const sourceId = createSafeId<"documentReviewRun">();
          try {
            await db.insert(pendingScoutEmissions).values(
              Array.from({ length: 100 }, () => ({
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                sourceKind: "infosoud-hearing" as const,
                sourceId: createSafeId<"entity">(),
                nextAttemptAt: new Date(NOW.getTime() - 60_000),
              })),
            );
            await db.insert(pendingScoutEmissions).values({
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              sourceKind: "document-review",
              sourceId,
              status: "awaiting_grant",
              nextAttemptAt: LATER,
            });
            await recoverScoutEmission(
              asTestRaw<SchedulerTaskContext>({
                db: asTestRaw<SchedulerDb>(db),
                dueAt: DueSlot.of({ nextRunAt: NOW, lockedAt: NOW }),
                logger,
                signal: new AbortController().signal,
              }),
            );
            expect(
              await db.$count(
                pendingScoutEmissions,
                eq(pendingScoutEmissions.sourceId, sourceId),
              ),
            ).toBe(0);
            const retained = await db
              .select()
              .from(pendingScoutEmissions)
              .where(
                eq(
                  pendingScoutEmissions.organizationId,
                  fixture.organizationId,
                ),
              );
            expect(retained).toHaveLength(100);
            expect(
              retained.every(({ status }) => status === "awaiting_grant"),
            ).toBe(true);
          } finally {
            await db
              .delete(organization)
              .where(eq(organization.id, fixture.organizationId));
            await db.delete(user).where(eq(user.id, fixture.userId));
          }
        },
      );
    } finally {
      env.FEATURE_SIGNALS = previousSignals;
      env.FEATURE_INBOX_DOCUMENT_SCOUTS = previousScouts;
      restoreMode();
    }
  });

  for (const change of TRIGGER_CHANGES) {
    test(`${change}: admission revalidates a claimed receipt and converges on replay`, async () => {
      const previousFlag = env.FEATURE_FLOWS;
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const first = openClient();
            const writer = openClient();
            const f = await uploadFixture(first.db);
            const db = asTestRaw<SchedulerDb>(first.db);
            const enqueued: string[] = [];
            const dependencies = {
              ...automatedFlowRunDependencies(db),
              enqueueStep: async ({ runId }) => {
                enqueued.push(runId);
              },
              kickoff: async ({ run }) =>
                await run(new AbortController().signal, async () => undefined),
            } satisfies Parameters<typeof startAutomatedFlowRun>[1];
            let starts = 0;
            const recover = async (now: Date) =>
              await recoverUploadFlowTriggerIntents({
                database: db,
                now,
                entityId: f.entityId,
                start: async (input) => {
                  starts += 1;
                  expect(
                    (
                      await first.db
                        .select()
                        .from(flowUploadTriggerIntents)
                        .where(
                          eq(flowUploadTriggerIntents.entityId, f.entityId),
                        )
                    ).at(0)?.retryAt,
                  ).toEqual(new Date(now.getTime() + 5 * 60_000));
                  // Another session commits after the receipt claim and before the authoritative start transaction.
                  await changeTrigger({ db: writer.db, fixture: f, change });
                  return await startAutomatedFlowRun(input, dependencies);
                },
              });
            try {
              await recover(NOW);
              const runs = await first.db
                .select()
                .from(flowRuns)
                .where(eq(flowRuns.definitionId, f.definitionId));
              const receipts = await first.db
                .select()
                .from(flowUploadTriggerIntents)
                .where(eq(flowUploadTriggerIntents.entityId, f.entityId));
              if (change === "unchanged") {
                expect(runs).toHaveLength(1);
                expect(enqueued).toEqual([runs.at(0)?.id]);
                expect(receipts).toEqual([]);
                // Recreate a still-pending receipt as if the process died after run commit and before settlement.
                await first.db.insert(flowUploadTriggerIntents).values({
                  definitionId: f.definitionId,
                  entityId: f.entityId,
                  organizationId: f.organizationId,
                  workspaceId: f.workspaceId,
                  fileExtension: "pdf",
                  retryAt: LATER,
                });
                await recover(LATER);
                expect(
                  await first.db.$count(
                    flowRuns,
                    eq(flowRuns.definitionId, f.definitionId),
                  ),
                ).toBe(1);
                expect(enqueued).toHaveLength(1);
              } else {
                expect(runs).toEqual([]);
                expect(enqueued).toEqual([]);
                expect(receipts).toHaveLength(1);
                expect(receipts.at(0)).toMatchObject({
                  status: "skipped",
                  skipReason:
                    change === "disabled"
                      ? "definition_disabled"
                      : "trigger_no_longer_matches",
                });
              }
              const settledStarts = starts;
              await recover(LATER);
              expect(starts).toBe(settledStarts);
            } finally {
              await first.db
                .delete(organization)
                .where(eq(organization.id, f.organizationId));
              await first.db.delete(user).where(eq(user.id, f.userId));
            }
          },
        );
      } finally {
        env.FEATURE_FLOWS = previousFlag;
        restoreMode();
      }
    });
  }
});
