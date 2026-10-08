import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  entities,
  flowDefinitions,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { StartAutomatedFlowRunArgs } from "@/api/lib/flows/start-automated-flow-run";
import { recordUploadTriggeredFlowIntents } from "@/api/lib/flows/upload-trigger-recording";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { recoverUploadFlowTriggerIntents } from "./upload-flow-trigger-recovery";

const database = await getTestDb();
const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const NOW = new Date("2026-10-08T12:00:00Z");
const RETRY = new Date("2026-10-08T12:05:00Z");

beforeAll(async () => {
  await database.insert(organization).values({
    id: organizationId,
    name: "Upload recovery",
    slug: `upload-${organizationId}`,
    createdAt: NOW,
  });
  await database.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Upload matter",
    reference: "UPLOAD-1",
  });
});
afterAll(async () => {
  await releaseTestDb();
});

const createUpload = async () => {
  const definitionId = createSafeId<"flowDefinition">();
  const entityId = createSafeId<"entity">();
  await database.insert(flowDefinitions).values({
    id: definitionId,
    organizationId,
    name: "Upload flow",
    steps: [],
    enabled: true,
    trigger: {
      type: "file-upload",
      workspaceIds: [workspaceId],
      fileExtensions: ["pdf"],
    },
  });
  await database
    .insert(entities)
    .values({ id: entityId, workspaceId, name: "fixture.pdf" });
  await database.insert(flowUploadTriggerIntents).values({
    definitionId,
    entityId,
    organizationId,
    workspaceId,
    fileExtension: "pdf",
    retryAt: NOW,
  });
  return { entityId, definitionId };
};

const receiptsFor = async (entityId: (typeof entities.$inferSelect)["id"]) =>
  await database
    .select()
    .from(flowUploadTriggerIntents)
    .where(eq(flowUploadTriggerIntents.entityId, entityId));

const recover = async ({
  entityId,
  now,
  start,
}: {
  entityId: (typeof entities.$inferSelect)["id"];
  now: Date;
  start: NonNullable<
    Parameters<typeof recoverUploadFlowTriggerIntents>[0]["start"]
  >;
}) =>
  await recoverUploadFlowTriggerIntents({
    database: asTestRaw<SchedulerDb>(database),
    entityId,
    now,
    start,
  });

describe("durable upload-trigger recovery", () => {
  for (const status of ["paused", "retry"] as const) {
    test(`${status} retains the receipt and re-grant or retry settles the same upload`, async () => {
      const { entityId, definitionId } = await createUpload();
      const starts: StartAutomatedFlowRunArgs[] = [];
      const skipped = await recover({
        entityId,
        now: NOW,
        start: async (input) => {
          starts.push(input);
          return { status };
        },
      });
      expect(skipped).toEqual({
        settled: 0,
        paused: status === "paused" ? 1 : 0,
        retry: status === "retry" ? 1 : 0,
      });
      const receipts = await receiptsFor(entityId);
      expect(receipts).toHaveLength(1);
      expect(receipts.at(0)?.retryAt).toEqual(RETRY);
      await recover({
        entityId,
        now: NOW,
        start: async (input) => {
          starts.push(input);
          return { status: "settled" };
        },
      });
      expect(starts).toHaveLength(1);
      await recover({
        entityId,
        now: RETRY,
        start: async (input) => {
          starts.push(input);
          return { status: "settled" };
        },
      });
      expect(starts).toHaveLength(2);
      expect(starts.at(0)?.definitionId).toBe(definitionId);
      expect(starts.at(0)?.triggerSource).toEqual({
        type: "file-upload",
        entityId,
      });
      expect(starts.at(1)).toEqual(starts.at(0));
      expect(await receiptsFor(entityId)).toHaveLength(0);
    });
  }

  test("a changed trigger settles the receipt without starting stale work", async () => {
    const { entityId, definitionId } = await createUpload();
    await database
      .update(flowDefinitions)
      .set({ trigger: { type: "manual" } })
      .where(eq(flowDefinitions.id, definitionId));
    let starts = 0;
    const result = await recover({
      entityId,
      now: NOW,
      start: async () => {
        starts += 1;
        return { status: "settled" };
      },
    });
    expect(result.settled).toBe(1);
    expect(starts).toBe(0);
    expect(await receiptsFor(entityId)).toHaveLength(0);
  });

  test("recording upload intents twice converges and rolls back with document creation", async () => {
    const { entityId, definitionId } = await createUpload();
    await database
      .delete(flowUploadTriggerIntents)
      .where(eq(flowUploadTriggerIntents.entityId, entityId));
    const upload = {
      entityId,
      organizationId,
      workspaceId,
      fileName: "fixture.PDF",
    };
    await recordUploadTriggeredFlowIntents(
      asTestRaw<Parameters<typeof recordUploadTriggeredFlowIntents>[0]>(
        database,
      ),
      upload,
    );
    await recordUploadTriggeredFlowIntents(
      asTestRaw<Parameters<typeof recordUploadTriggeredFlowIntents>[0]>(
        database,
      ),
      upload,
    );
    const receipts = await receiptsFor(entityId);
    expect(
      receipts.filter((receipt) => receipt.definitionId === definitionId),
    ).toHaveLength(1);
    const rollbackEntityId = createSafeId<"entity">();
    await database
      .transaction(async (tx) => {
        await tx
          .insert(entities)
          .values({ id: rollbackEntityId, workspaceId, name: "rollback.pdf" });
        await recordUploadTriggeredFlowIntents(
          asTestRaw<Parameters<typeof recordUploadTriggeredFlowIntents>[0]>(tx),
          { ...upload, entityId: rollbackEntityId },
        );
        expect(
          (
            await tx
              .select()
              .from(flowUploadTriggerIntents)
              .where(eq(flowUploadTriggerIntents.entityId, rollbackEntityId))
          ).length,
        ).toBeGreaterThan(0);
        tx.rollback();
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(TransactionRollbackError);
      });
    expect(await receiptsFor(rollbackEntityId)).toHaveLength(0);
  });
});
