import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { recoverUploadFlowTriggerIntents } from "./upload-flow-trigger-recovery";

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
