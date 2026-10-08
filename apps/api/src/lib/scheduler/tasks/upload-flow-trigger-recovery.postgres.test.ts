import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { fileUploadTriggerMatchesSql } from "@/api/lib/flows/flow-trigger-logic";
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

type ReceiptRaceDatabaseOptions = {
  database: GatedTestDb;
  beforeTransaction: (ordinal: number) => Promise<void>;
  rollbackFirst?: boolean;
};

const receiptRaceDatabase = ({
  database,
  beforeTransaction,
  rollbackFirst,
}: ReceiptRaceDatabaseOptions) => {
  let ordinal = 0;
  return asTestRaw<SchedulerDb>({
    select: database.select.bind(database),
    query: database.query,
    transaction: async (
      operation: Parameters<SchedulerDb["transaction"]>[0],
    ) => {
      ordinal += 1;
      const current = ordinal;
      await beforeTransaction(current);
      return await database.transaction(async (tx) => {
        const value = await operation(
          asTestRaw<Parameters<typeof operation>[0]>(tx),
        );
        if (rollbackFirst && current === 1) {
          throw new HandlerError({
            status: 500,
            message: "Synthetic receipt effect rollback",
          });
        }
        return value;
      });
    },
  });
};
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
  test("workspace-filtered uploads match UUID receipt columns and parameter inputs", async () => {
    await withGatedTestClients(
      databaseUrl ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await uploadFixture(db);
        try {
          const cases = [
            {
              workspaceId: fixture.workspaceId,
              extensions: [".PDF"],
              expected: true,
            },
            {
              workspaceId: fixture.otherWorkspaceId,
              extensions: [".PDF"],
              expected: false,
            },
            {
              workspaceId: fixture.workspaceId,
              extensions: [".DOCX"],
              expected: false,
            },
            {
              workspaceId: fixture.otherWorkspaceId,
              extensions: [".DOCX"],
              expected: false,
            },
          ];
          for (const { workspaceId, extensions, expected } of cases) {
            // db-await-in-loop: each persisted trigger configuration exercises both SQL operand types.
            await db
              .update(flowDefinitions)
              .set({
                trigger: {
                  type: "file-upload",
                  workspaceIds: [workspaceId],
                  fileExtensions: extensions,
                },
              })
              .where(eq(flowDefinitions.id, fixture.definitionId));
            // db-await-in-loop: read the real UUID receipt column after the configuration change.
            const rows = await db
              .select({
                columnMatches: fileUploadTriggerMatchesSql({
                  trigger: flowDefinitions.trigger,
                  workspaceId: flowUploadTriggerIntents.workspaceId,
                  extension: flowUploadTriggerIntents.fileExtension,
                }).mapWith(Boolean),
                parameterMatches: fileUploadTriggerMatchesSql({
                  trigger: flowDefinitions.trigger,
                  workspaceId: fixture.workspaceId,
                  extension: "pdf",
                }).mapWith(Boolean),
              })
              .from(flowUploadTriggerIntents)
              .innerJoin(
                flowDefinitions,
                eq(flowDefinitions.id, flowUploadTriggerIntents.definitionId),
              )
              .where(
                and(
                  eq(
                    flowUploadTriggerIntents.organizationId,
                    fixture.organizationId,
                  ),
                  eq(
                    flowUploadTriggerIntents.definitionId,
                    fixture.definitionId,
                  ),
                  eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                ),
              )
              .limit(1);
            expect(rows).toEqual([
              { columnMatches: expected, parameterMatches: expected },
            ]);
          }
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, fixture.organizationId));
          await db.delete(user).where(eq(user.id, fixture.userId));
        }
      },
    );
  });

  test("inactive receipt prefixes do not consume dispatch budget and scoped uploads avoid foreign reconciliation", async () => {
    const previous = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const { db } = openClient();
          const fixture = await uploadFixture(db);
          const foreign = await uploadFixture(db);
          try {
            await db
              .delete(featureEnrolments)
              .where(
                eq(featureEnrolments.organizationId, foreign.organizationId),
              );
            await db
              .update(workspaces)
              .set({ status: "archived" })
              .where(eq(workspaces.id, fixture.otherWorkspaceId));
            await db.insert(workspaceMembers).values({
              workspaceId: fixture.otherWorkspaceId,
              userId: fixture.userId,
            });
            const prefix = Array.from({ length: 32 }, () =>
              createSafeId<"entity">(),
            );
            await db.insert(entities).values(
              prefix.map((id) => ({
                id,
                workspaceId: fixture.otherWorkspaceId,
                name: "parked.pdf",
              })),
            );
            await db.insert(flowUploadTriggerIntents).values(
              prefix.map((entityId) => ({
                entityId,
                definitionId: fixture.definitionId,
                organizationId: fixture.organizationId,
                workspaceId: fixture.otherWorkspaceId,
                fileExtension: "pdf",
                retryAt: new Date(NOW.getTime() - 60_000),
              })),
            );
            const started: string[] = [];
            const scoped = await recoverUploadFlowTriggerIntents({
              database: asTestRaw<SchedulerDb>(db),
              entityId: fixture.entityId,
              now: NOW,
              start: async ({ definitionId }) => {
                started.push(definitionId);
                return { status: "settled" };
              },
            });
            expect(scoped.settled).toBe(1);
            expect(
              (
                await db
                  .select()
                  .from(flowUploadTriggerIntents)
                  .where(
                    eq(flowUploadTriggerIntents.entityId, foreign.entityId),
                  )
              ).at(0)?.status,
            ).toBe("pending");
            await db.insert(flowUploadTriggerIntents).values({
              definitionId: fixture.definitionId,
              entityId: fixture.entityId,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              fileExtension: "pdf",
              retryAt: NOW,
            });
            const global = await recoverUploadFlowTriggerIntents({
              database: asTestRaw<SchedulerDb>(db),
              now: NOW,
              start: async ({ definitionId }) => {
                started.push(definitionId);
                return { status: "settled" };
              },
            });
            expect(global.settled).toBe(1);
            expect(started).toEqual([
              fixture.definitionId,
              fixture.definitionId,
            ]);
            expect(
              await db.$count(
                flowUploadTriggerIntents,
                eq(
                  flowUploadTriggerIntents.workspaceId,
                  fixture.otherWorkspaceId,
                ),
              ),
            ).toBe(32);
          } finally {
            await db
              .delete(organization)
              .where(eq(organization.id, fixture.organizationId));
            await db.delete(user).where(eq(user.id, fixture.userId));
            await db
              .delete(organization)
              .where(eq(organization.id, foreign.organizationId));
            await db.delete(user).where(eq(user.id, foreign.userId));
          }
        },
      );
    } finally {
      env.FEATURE_FLOWS = previous;
      restore();
    }
  });
  for (const featureId of ["signals", "flows"] as const) {
    for (const state of ["pending", "awaiting_grant"] as const) {
      test(`${featureId}/${state}: SQL microsecond receipt tokens survive selection and settle`, async () => {
        const previousSignals = env.FEATURE_SIGNALS;
        const previousFlows = env.FEATURE_FLOWS;
        const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        env.FEATURE_SIGNALS = true;
        env.FEATURE_FLOWS = true;
        env.FEATURE_INBOX_DOCUMENT_SCOUTS = true;
        try {
          await withGatedTestClients(
            databaseUrl ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const { db } = openClient();
              const fixture = await uploadFixture(db);
              const sourceId = createSafeId<"documentReviewRun">();
              const token = sql`${NOW}::timestamptz - interval '1 second' + interval '123 microseconds'`;
              try {
                if (featureId === "flows") {
                  await db
                    .update(flowUploadTriggerIntents)
                    .set({ retryAt: token, status: state })
                    .where(
                      eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                    );
                  const before = (
                    await db
                      .select({
                        token: sql<string>`${flowUploadTriggerIntents.retryAt}::text`,
                      })
                      .from(flowUploadTriggerIntents)
                      .where(
                        eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                      )
                  ).at(0);
                  expect(before?.token).toContain(".000123");
                  let dispatched = 0;
                  const outcome = await recoverUploadFlowTriggerIntents({
                    database: asTestRaw<SchedulerDb>(db),
                    now: NOW,
                    start: async () => {
                      dispatched += 1;
                      return { status: "settled" };
                    },
                  });
                  expect(dispatched).toBe(1);
                  expect(outcome.settled).toBe(1);
                  expect(
                    await db.$count(
                      flowUploadTriggerIntents,
                      eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                    ),
                  ).toBe(0);
                } else {
                  // Missing sources are terminal, so this reaches receipt claim and dequeue without emission.
                  await db.insert(pendingScoutEmissions).values({
                    organizationId: fixture.organizationId,
                    workspaceId: fixture.workspaceId,
                    sourceKind: "document-review",
                    sourceId,
                    status: state,
                    nextAttemptAt: token,
                  });
                  const before = (
                    await db
                      .select({
                        token: sql<string>`${pendingScoutEmissions.nextAttemptAt}::text`,
                      })
                      .from(pendingScoutEmissions)
                      .where(eq(pendingScoutEmissions.sourceId, sourceId))
                  ).at(0);
                  expect(before?.token).toContain(".000123");
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
                }
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
          env.FEATURE_FLOWS = previousFlows;
          env.FEATURE_INBOX_DOCUMENT_SCOUTS = previousScouts;
          restore();
        }
      });
    }
  }
  for (const featureId of ["signals", "flows"] as const) {
    for (const state of ["pending", "awaiting_grant"] as const) {
      test(`${featureId}/${state}: grant reconciliation preserves a newer selected token`, async () => {
        const previousSignals = env.FEATURE_SIGNALS;
        const previousFlows = env.FEATURE_FLOWS;
        const restoreMode = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        env.FEATURE_SIGNALS = true;
        env.FEATURE_FLOWS = true;
        try {
          await withGatedTestClients(
            databaseUrl ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const reader = openClient();
              const writer = openClient();
              const fixture = await uploadFixture(reader.db);
              try {
                if (featureId === "flows") {
                  await reader.db
                    .update(flowUploadTriggerIntents)
                    .set({ status: state })
                    .where(
                      eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                    );
                  if (state === "pending") {
                    await reader.db
                      .delete(featureEnrolments)
                      .where(
                        eq(
                          featureEnrolments.organizationId,
                          fixture.organizationId,
                        ),
                      );
                  }
                } else {
                  await reader.db.insert(pendingScoutEmissions).values({
                    organizationId: fixture.organizationId,
                    workspaceId: fixture.workspaceId,
                    sourceId: fixture.entityId,
                    status: state,
                    nextAttemptAt: NOW,
                    sourceKind:
                      state === "awaiting_grant"
                        ? "document-review"
                        : "infosoud-hearing",
                  });
                }
                let barriers = 0;
                const database = receiptRaceDatabase({
                  database: reader.db,
                  beforeTransaction: async (ordinal) => {
                    if (ordinal !== 1) {
                      return;
                    }
                    barriers += 1;
                    await writer.db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: fixture.organizationId,
                        featureId,
                      });
                      if (featureId === "flows") {
                        await tx
                          .update(flowUploadTriggerIntents)
                          .set({ retryAt: LATER })
                          .where(
                            eq(
                              flowUploadTriggerIntents.entityId,
                              fixture.entityId,
                            ),
                          );
                      } else {
                        await tx
                          .update(pendingScoutEmissions)
                          .set({ nextAttemptAt: LATER })
                          .where(
                            eq(
                              pendingScoutEmissions.sourceId,
                              fixture.entityId,
                            ),
                          );
                      }
                    });
                  },
                });
                if (featureId === "flows") {
                  await recoverUploadFlowTriggerIntents({
                    database,
                    now: NOW,
                    start: async () =>
                      panic("Stale reconciliation dispatched a source"),
                  });
                  expect(
                    (
                      await reader.db
                        .select()
                        .from(flowUploadTriggerIntents)
                        .where(
                          eq(
                            flowUploadTriggerIntents.entityId,
                            fixture.entityId,
                          ),
                        )
                    ).at(0),
                  ).toMatchObject({ status: state, retryAt: LATER });
                } else {
                  await recoverScoutEmission(
                    asTestRaw<SchedulerTaskContext>({
                      db: database,
                      dueAt: DueSlot.of({ nextRunAt: NOW, lockedAt: NOW }),
                      logger,
                      signal: new AbortController().signal,
                    }),
                  );
                  expect(
                    (
                      await reader.db
                        .select()
                        .from(pendingScoutEmissions)
                        .where(
                          eq(pendingScoutEmissions.sourceId, fixture.entityId),
                        )
                    ).at(0),
                  ).toMatchObject({ status: state, nextAttemptAt: LATER });
                }
                expect(barriers).toBe(1);
              } finally {
                await reader.db
                  .delete(organization)
                  .where(eq(organization.id, fixture.organizationId));
                await reader.db.delete(user).where(eq(user.id, fixture.userId));
              }
            },
          );
        } finally {
          env.FEATURE_SIGNALS = previousSignals;
          env.FEATURE_FLOWS = previousFlows;
          restoreMode();
        }
      });
    }
  }

  for (const race of [
    "claim-replaced",
    "settlement-replaced",
    "settlement-revoked",
  ] as const) {
    test(`${race}: upload recovery preserves the winning receipt without stale effects`, async () => {
      const previous = env.FEATURE_FLOWS;
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const reader = openClient();
            const writer = openClient();
            const fixture = await uploadFixture(reader.db);
            const mutate = async () =>
              await writer.db.transaction(async (tx) => {
                await lockFeatureRecoveryAdmission({
                  tx,
                  organizationId: fixture.organizationId,
                  featureId: "flows",
                });
                if (race === "settlement-revoked") {
                  await tx
                    .delete(featureEnrolments)
                    .where(
                      eq(
                        featureEnrolments.organizationId,
                        fixture.organizationId,
                      ),
                    );
                } else {
                  await tx
                    .update(flowUploadTriggerIntents)
                    .set({ retryAt: LATER })
                    .where(
                      eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                    );
                }
              });
            let starts = 0;
            try {
              const outcomes = await recoverUploadFlowTriggerIntents({
                database: receiptRaceDatabase({
                  database: reader.db,
                  beforeTransaction: async (ordinal) => {
                    if (race === "claim-replaced" && ordinal === 1) {
                      await mutate();
                    }
                  },
                }),
                now: NOW,
                entityId: fixture.entityId,
                start: async ({ uploadTriggerClaimToken }) => {
                  starts += 1;
                  const current = (
                    await reader.db
                      .select({
                        token: timestampCasToken(
                          flowUploadTriggerIntents.retryAt,
                        ),
                      })
                      .from(flowUploadTriggerIntents)
                      .where(
                        eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                      )
                  ).at(0);
                  expect(uploadTriggerClaimToken).toBe(current?.token);
                  await mutate();
                  return { status: "settled" };
                },
              });
              const receipt = (
                await reader.db
                  .select()
                  .from(flowUploadTriggerIntents)
                  .where(
                    eq(flowUploadTriggerIntents.entityId, fixture.entityId),
                  )
              ).at(0);
              expect(receipt?.status).toBe("pending");
              expect(receipt?.retryAt).toEqual(
                race === "settlement-revoked"
                  ? new Date(NOW.getTime() + 5 * 60_000)
                  : LATER,
              );
              expect(starts).toBe(race === "claim-replaced" ? 0 : 1);
              expect(outcomes.settled).toBe(0);
              expect(outcomes.stale).toBe(
                race === "settlement-revoked" ? 0 : 1,
              );
              expect(outcomes.paused).toBe(
                race === "settlement-revoked" ? 1 : 0,
              );
            } finally {
              await reader.db
                .delete(organization)
                .where(eq(organization.id, fixture.organizationId));
              await reader.db.delete(user).where(eq(user.id, fixture.userId));
            }
          },
        );
      } finally {
        env.FEATURE_FLOWS = previous;
        restoreMode();
      }
    });
  }

  for (const race of [
    "claim-replaced",
    "grant-revoked",
    "rollback-replaced",
  ] as const) {
    test(`${race}: scout recovery cannot overwrite a newer receipt or emit after revocation`, async () => {
      const previous = env.FEATURE_SIGNALS;
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      env.FEATURE_SIGNALS = true;
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const reader = openClient();
            const writer = openClient();
            const fixture = await uploadFixture(reader.db);
            try {
              await reader.db.insert(featureEnrolments).values({
                organizationId: fixture.organizationId,
                userId: fixture.userId,
                featureId: "signals",
              });
              await reader.db.insert(pendingScoutEmissions).values({
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                sourceKind: "infosoud-hearing",
                sourceId: fixture.entityId,
                nextAttemptAt: NOW,
              });
              const database = receiptRaceDatabase({
                database: reader.db,
                rollbackFirst: race === "rollback-replaced",
                beforeTransaction: async (ordinal) => {
                  if (ordinal !== (race === "rollback-replaced" ? 2 : 1)) {
                    return;
                  }
                  await writer.db.transaction(async (tx) => {
                    await lockFeatureRecoveryAdmission({
                      tx,
                      organizationId: fixture.organizationId,
                      featureId: "signals",
                    });
                    if (race === "grant-revoked") {
                      await tx
                        .delete(featureEnrolments)
                        .where(
                          and(
                            eq(
                              featureEnrolments.organizationId,
                              fixture.organizationId,
                            ),
                            eq(featureEnrolments.featureId, "signals"),
                          ),
                        );
                    } else {
                      await tx
                        .update(pendingScoutEmissions)
                        .set({ nextAttemptAt: LATER })
                        .where(
                          eq(pendingScoutEmissions.sourceId, fixture.entityId),
                        );
                    }
                  });
                },
              });
              await recoverScoutEmission(
                asTestRaw<SchedulerTaskContext>({
                  db: database,
                  dueAt: DueSlot.of({ nextRunAt: NOW, lockedAt: NOW }),
                  logger,
                  signal: new AbortController().signal,
                }),
              );
              const receipt = (
                await reader.db
                  .select()
                  .from(pendingScoutEmissions)
                  .where(eq(pendingScoutEmissions.sourceId, fixture.entityId))
              ).at(0);
              expect(receipt).toMatchObject({
                status: "pending",
                lastError: null,
              });
              expect(receipt?.nextAttemptAt).toEqual(
                race === "grant-revoked" ? NOW : LATER,
              );
            } finally {
              await reader.db
                .delete(organization)
                .where(eq(organization.id, fixture.organizationId));
              await reader.db.delete(user).where(eq(user.id, fixture.userId));
            }
          },
        );
      } finally {
        env.FEATURE_SIGNALS = previous;
        restoreMode();
      }
    });
  }

  test("a grant revoked after preflight pauses insertion without spending and regrant converges", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const reader = openClient();
          const writer = openClient();
          const fixture = await uploadFixture(reader.db);
          const production = automatedFlowRunDependencies(
            asTestRaw<SchedulerDb>(reader.db),
          );
          let admittedPreflights = 0;
          let reservations = 0;
          let revokeAtInsert = true;
          const enqueued: string[] = [];
          const dependencies = {
            ...production,
            featureEnabled: async (principal) => {
              const admitted = await production.featureEnabled(principal);
              if (admitted) {
                admittedPreflights += 1;
              }
              return admitted;
            },
            insertWithinCap: async (input) => {
              if (revokeAtInsert) {
                expect(admittedPreflights).toBe(1);
                await writer.db.transaction(async (tx) => {
                  await lockFeatureRecoveryAdmission({
                    tx,
                    organizationId: fixture.organizationId,
                    featureId: "flows",
                  });
                  await tx
                    .delete(featureEnrolments)
                    .where(
                      and(
                        eq(
                          featureEnrolments.organizationId,
                          fixture.organizationId,
                        ),
                        eq(featureEnrolments.userId, fixture.userId),
                        eq(featureEnrolments.featureId, "flows"),
                      ),
                    );
                });
                revokeAtInsert = false;
              }
              return await production.insertWithinCap(input);
            },
            enqueueStep: async ({ runId }) => {
              enqueued.push(runId);
            },
            kickoff: async ({ run }) =>
              await run(new AbortController().signal, async () => {
                reservations += 1;
              }),
          } satisfies Parameters<typeof startAutomatedFlowRun>[1];
          const original =
            (
              await reader.db
                .select({
                  token: timestampCasToken(flowUploadTriggerIntents.retryAt),
                })
                .from(flowUploadTriggerIntents)
                .where(eq(flowUploadTriggerIntents.entityId, fixture.entityId))
            ).at(0) ?? panic("Missing direct-start receipt");
          const start = async () =>
            await startAutomatedFlowRun(
              {
                definitionId: fixture.definitionId,
                uploadTriggerClaimToken: original.token,
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                createdByUserId: fixture.userId,
                triggerSource: {
                  type: "file-upload",
                  entityId: fixture.entityId,
                },
                inputEntityIds: [fixture.entityId],
                logContext: {
                  definitionId: fixture.definitionId,
                  workspaceId: fixture.workspaceId,
                  trigger: "file-upload",
                },
              },
              dependencies,
            );
          try {
            expect(await start()).toEqual({ status: "paused" });
            expect(admittedPreflights).toBe(1);
            expect(reservations).toBe(0);
            expect(enqueued).toEqual([]);
            expect(
              await reader.db.$count(
                flowRuns,
                eq(flowRuns.definitionId, fixture.definitionId),
              ),
            ).toBe(0);
            expect(
              await reader.db.$count(
                flowRunSteps,
                eq(flowRunSteps.workspaceId, fixture.workspaceId),
              ),
            ).toBe(0);
            expect(
              await reader.db.$count(
                flowUploadTriggerIntents,
                eq(flowUploadTriggerIntents.entityId, fixture.entityId),
              ),
            ).toBe(1);

            await writer.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: fixture.organizationId,
                featureId: "flows",
              });
              await tx.insert(featureEnrolments).values({
                organizationId: fixture.organizationId,
                userId: fixture.userId,
                featureId: "flows",
              });
            });
            expect(await start()).toEqual({ status: "settled" });
            expect(await start()).toEqual({ status: "settled" });
            expect(admittedPreflights).toBe(3);
            expect(reservations).toBe(1);
            expect(enqueued).toHaveLength(1);
            expect(
              await reader.db.$count(
                flowRuns,
                eq(flowRuns.definitionId, fixture.definitionId),
              ),
            ).toBe(1);
            expect(
              await reader.db.$count(
                flowRunSteps,
                eq(flowRunSteps.workspaceId, fixture.workspaceId),
              ),
            ).toBe(1);
          } finally {
            await reader.db
              .delete(organization)
              .where(eq(organization.id, fixture.organizationId));
            await reader.db.delete(user).where(eq(user.id, fixture.userId));
          }
        },
      );
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restoreMode();
    }
  });

  test.each(["awaiting_grant", "skipped"] as const)(
    "%s grant repair joins live definitions before retained historical skips",
    async (status) => {
      const previousFlag = env.FEATURE_FLOWS;
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const queries: string[] = [];
            const { db } = openClient({
              logger: {
                logQuery(query) {
                  queries.push(query);
                },
              },
            });
            const disabled = await uploadFixture(db);
            const authorless = await uploadFixture(db);
            const eligible = await uploadFixture(db);
            try {
              const older = new Date(NOW.getTime() - 60_000);
              await db
                .update(flowDefinitions)
                .set({ enabled: false })
                .where(eq(flowDefinitions.id, disabled.definitionId));
              await db
                .update(flowDefinitions)
                .set({ createdByUserId: null })
                .where(eq(flowDefinitions.id, authorless.definitionId));
              await db
                .update(flowUploadTriggerIntents)
                .set({
                  status: "skipped",
                  skipReason: "definition_disabled",
                  retryAt: older,
                })
                .where(
                  eq(
                    flowUploadTriggerIntents.definitionId,
                    disabled.definitionId,
                  ),
                );
              await db
                .update(flowUploadTriggerIntents)
                .set({
                  status: "skipped",
                  skipReason: "actor_missing",
                  retryAt: older,
                })
                .where(
                  eq(
                    flowUploadTriggerIntents.definitionId,
                    authorless.definitionId,
                  ),
                );
              const extra = Array.from({ length: 99 }, () => ({
                id: createSafeId<"entity">(),
                workspaceId: disabled.workspaceId,
                name: "Historical upload",
                createdBy: disabled.userId,
              }));
              await db.insert(entities).values(extra);
              await db.insert(flowUploadTriggerIntents).values(
                extra.map(({ id }) => ({
                  definitionId: disabled.definitionId,
                  entityId: id,
                  organizationId: disabled.organizationId,
                  workspaceId: disabled.workspaceId,
                  fileExtension: "pdf",
                  status: "skipped" as const,
                  skipReason: "definition_disabled" as const,
                  retryAt: older,
                })),
              );
              await db
                .update(flowUploadTriggerIntents)
                .set({
                  status,
                  skipReason:
                    status === "skipped" ? "definition_disabled" : null,
                  retryAt: LATER,
                })
                .where(
                  eq(
                    flowUploadTriggerIntents.definitionId,
                    eligible.definitionId,
                  ),
                );
              const retained = async () =>
                await db
                  .select()
                  .from(flowUploadTriggerIntents)
                  .where(
                    sql`${flowUploadTriggerIntents.definitionId} IN (${disabled.definitionId}, ${authorless.definitionId})`,
                  )
                  .orderBy(
                    asc(flowUploadTriggerIntents.definitionId),
                    asc(flowUploadTriggerIntents.entityId),
                  );
              const before = await retained();
              queries.length = 0;
              const started: string[] = [];
              await recoverUploadFlowTriggerIntents({
                database: asTestRaw<SchedulerDb>(db),
                now: NOW,
                start: async ({ definitionId }) => {
                  started.push(definitionId);
                  return { status: "settled" };
                },
              });
              expect(started).toEqual([eligible.definitionId]);
              expect(await retained()).toEqual(before);
              expect(
                await db.$count(
                  flowUploadTriggerIntents,
                  eq(
                    flowUploadTriggerIntents.definitionId,
                    eligible.definitionId,
                  ),
                ),
              ).toBe(0);
              const resumedQuery = queries.find((query) =>
                /from\s+"flow_definitions"\s+inner join\s+"flow_upload_trigger_intents"/iu.test(
                  query,
                ),
              );
              expect(resumedQuery).toBeDefined();
              expect(resumedQuery).toContain('"flow_definitions"."enabled"');
              expect(resumedQuery?.toLowerCase()).toContain(
                '"flow_definitions"."created_by_user_id" is not null',
              );
            } finally {
              for (const fixture of [disabled, authorless, eligible]) {
                // db-await-in-loop: clean each separately seeded tenant and its principal.
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
    },
  );

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
                ...(entityId === undefined ? {} : { entityId }),
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
                const insertedRun =
                  runs.at(0) ?? panic("Missing replay fixture run");
                expect(enqueued).toEqual([insertedRun.id]);
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
