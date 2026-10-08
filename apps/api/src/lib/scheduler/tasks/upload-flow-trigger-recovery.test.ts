import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  featureEnrolments,
  workspaceMembers,
  flowDefinitions,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import {
  fileUploadTriggerMatches,
  fileUploadTriggerMatchesSql,
} from "@/api/lib/flows/flow-trigger-logic";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type { StartAutomatedFlowRunArgs } from "@/api/lib/flows/start-automated-flow-run";
import { recordUploadTriggeredFlowIntents } from "@/api/lib/flows/upload-trigger-recording";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { recoverUploadFlowTriggerIntents } from "./upload-flow-trigger-recovery";

const database = await getTestDb();
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
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
  await database.insert(user).values({
    id: userId,
    name: "Upload author",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await database.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: NOW,
  });
  await database
    .insert(featureEnrolments)
    .values({ organizationId, userId, featureId: "flows" });
  await database.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Upload matter",
    reference: "UPLOAD-1",
  });
  await database.insert(workspaceMembers).values({ workspaceId, userId });
});
afterEach(async () => {
  await database
    .delete(flowDefinitions)
    .where(eq(flowDefinitions.organizationId, organizationId));
  await database.delete(entities).where(eq(entities.workspaceId, workspaceId));
});
afterAll(async () => {
  await database
    .delete(organization)
    .where(eq(organization.id, organizationId));
  await database.delete(user).where(eq(user.id, userId));
  await releaseTestDb();
});

const createUpload = async () => {
  const definitionId = createSafeId<"flowDefinition">();
  const entityId = createSafeId<"entity">();
  await database.insert(flowDefinitions).values({
    id: definitionId,
    organizationId,
    name: "Upload flow",
    createdByUserId: userId,
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

const assertClaimToken = async (input: StartAutomatedFlowRunArgs) => {
  const entityId =
    input.inputEntityIds.at(0) ??
    panic("Upload claim fixture is missing its entity");
  const row = (
    await database
      .select({ token: timestampCasToken(flowUploadTriggerIntents.retryAt) })
      .from(flowUploadTriggerIntents)
      .where(eq(flowUploadTriggerIntents.entityId, entityId))
  ).at(0);
  expect(row).toBeDefined();
  expect(input.uploadTriggerClaimToken).toBe(row?.token);
};

describe("durable upload-trigger recovery", () => {
  for (const status of ["paused", "retry"] as const) {
    test(`${status} retains the receipt and re-grant or retry settles the same upload`, async () => {
      const { entityId, definitionId } = await createUpload();
      const starts: StartAutomatedFlowRunArgs[] = [];
      const skipped = await recover({
        entityId,
        now: NOW,
        start: async (input) => {
          await assertClaimToken(input);
          starts.push(input);
          return { status };
        },
      });
      expect(skipped).toEqual({
        settled: 0,
        skipped: 0,
        stale: 0,
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
          await assertClaimToken(input);
          starts.push(input);
          return { status: "settled" };
        },
      });
      expect(starts).toHaveLength(1);
      await recover({
        entityId,
        now: RETRY,
        start: async (input) => {
          await assertClaimToken(input);
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
      expect(starts.at(1)?.uploadTriggerClaimToken).not.toBe(
        starts.at(0)?.uploadTriggerClaimToken,
      );
      expect(starts.at(1)).toEqual({
        ...starts.at(0),
        uploadTriggerClaimToken: starts.at(1)?.uploadTriggerClaimToken,
      });
      expect(await receiptsFor(entityId)).toHaveLength(0);
    });
  }

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

describe("upload receipt retention and eligible replay", () => {
  test("a missing author records its claimed receipt rather than deleting it", async () => {
    const { entityId, definitionId } = await createUpload();
    await database
      .update(flowDefinitions)
      .set({ createdByUserId: null })
      .where(eq(flowDefinitions.id, definitionId));
    const outcome = await recover({
      entityId,
      now: NOW,
      start: async (input) =>
        await startAutomatedFlowRun(
          input,
          automatedFlowRunDependencies(
            asTestRaw<Parameters<typeof automatedFlowRunDependencies>[0]>(
              database,
            ),
          ),
        ),
    });
    expect(outcome.skipped).toBe(1);
    expect(await receiptsFor(entityId)).toMatchObject([
      {
        definitionId,
        entityId,
        status: "skipped",
        skipReason: "actor_missing",
        retryAt: RETRY,
      },
    ]);
    const replay = await recover({
      entityId,
      now: RETRY,
      start: async () =>
        panic("Retained skipped receipt must not dispatch again"),
    });
    expect(replay.skipped).toBe(0);
    expect(await receiptsFor(entityId)).toHaveLength(1);
  });

  test("definition re-enable repairs a retained skip before bounded dispatch and converges", async () => {
    const { entityId, definitionId } = await createUpload();
    await database
      .update(flowDefinitions)
      .set({ enabled: false })
      .where(eq(flowDefinitions.id, definitionId));
    await recover({
      entityId,
      now: NOW,
      start: async () => ({ status: "skipped", reason: "definition_disabled" }),
    });
    expect(await receiptsFor(entityId)).toMatchObject([
      { status: "skipped", skipReason: "definition_disabled" },
    ]);
    await database
      .update(flowDefinitions)
      .set({ enabled: true })
      .where(eq(flowDefinitions.id, definitionId));
    let starts = 0;
    const sweep = () =>
      recoverUploadFlowTriggerIntents({
        database: asTestRaw<SchedulerDb>(database),
        now: RETRY,
        start: async () => {
          starts += 1;
          return { status: "settled" };
        },
      });
    expect((await sweep()).settled).toBe(1);
    expect(starts).toBe(1);
    expect(await receiptsFor(entityId)).toHaveLength(0);
    await sweep();
    expect(starts).toBe(1);
  });

  test("an ineligible skipped prefix does not consume the eligible repair batch", async () => {
    const receipts = Array.from({ length: 33 }, (_, index) => ({
      definitionId: createSafeId<"flowDefinition">(),
      entityId: createSafeId<"entity">(),
      eligible: index === 32,
    }));
    await database.insert(flowDefinitions).values(
      receipts.map((receipt) => ({
        id: receipt.definitionId,
        organizationId,
        name: "Retained upload flow",
        createdByUserId: userId,
        steps: [],
        enabled: receipt.eligible,
        trigger: {
          type: "file-upload" as const,
          workspaceIds: [workspaceId],
          fileExtensions: ["pdf"],
        },
      })),
    );
    await database.insert(entities).values(
      receipts.map((receipt) => ({
        id: receipt.entityId,
        workspaceId,
        name: "retained.pdf",
      })),
    );
    await database.insert(flowUploadTriggerIntents).values(
      receipts.map((receipt) => ({
        definitionId: receipt.definitionId,
        entityId: receipt.entityId,
        organizationId,
        workspaceId,
        fileExtension: "pdf",
        retryAt: NOW,
        status: "skipped" as const,
        skipReason: receipt.eligible
          ? ("trigger_no_longer_matches" as const)
          : ("definition_disabled" as const),
      })),
    );
    const eligible = receipts.at(32) ?? panic("Missing eligible receipt");
    const started: string[] = [];
    const sweep = () =>
      recoverUploadFlowTriggerIntents({
        database: asTestRaw<SchedulerDb>(database),
        now: RETRY,
        start: async (input) => {
          started.push(input.definitionId);
          return { status: "settled" };
        },
      });
    expect((await sweep()).settled).toBe(1);
    expect(started).toEqual([eligible.definitionId]);
    expect(await receiptsFor(eligible.entityId)).toHaveLength(0);
    expect(
      await database.$count(
        flowUploadTriggerIntents,
        eq(flowUploadTriggerIntents.organizationId, organizationId),
      ),
    ).toBe(32);
    await sweep();
    expect(started).toEqual([eligible.definitionId]);
  });

  test("an author removed while awaiting a grant is retained with a typed skip", async () => {
    const { entityId, definitionId } = await createUpload();
    await database
      .update(flowUploadTriggerIntents)
      .set({ status: "awaiting_grant" })
      .where(eq(flowUploadTriggerIntents.entityId, entityId));
    await database
      .update(flowDefinitions)
      .set({ createdByUserId: null })
      .where(eq(flowDefinitions.id, definitionId));
    await recoverUploadFlowTriggerIntents({
      database: asTestRaw<SchedulerDb>(database),
      now: RETRY,
      start: async () => panic("Missing author must remain a recorded receipt"),
    });
    expect(await receiptsFor(entityId)).toMatchObject([
      { status: "skipped", skipReason: "actor_missing", retryAt: NOW },
    ]);
  });
});

describe("upload trigger SQL eligibility", () => {
  test("SQL recovery eligibility agrees with configured workspace and extension normalization", async () => {
    const otherWorkspaceId = createSafeId<"workspace">();
    const workspaceFilters = [null, [], [workspaceId], [otherWorkspaceId]];
    const extensionFilters = [null, [], ["PDF", ".docx", "..txt"]];
    const cases = workspaceFilters.flatMap((workspaceIds) =>
      extensionFilters.flatMap((fileExtensions) =>
        [null, "pdf", "docx", "txt", "gz"].map((extension) => ({
          trigger: {
            type: "file-upload" as const,
            workspaceIds,
            fileExtensions,
          },
          extension,
        })),
      ),
    );
    await Promise.all(
      cases.map(async ({ trigger, extension }) => {
        const rows = await database
          .select({
            matches: fileUploadTriggerMatchesSql({
              trigger: sql`${JSON.stringify(trigger)}::text::jsonb`,
              workspaceId,
              extension,
            }).mapWith(Boolean),
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        expect(rows.at(0)?.matches).toBe(
          fileUploadTriggerMatches({ trigger, workspaceId, extension }),
        );
      }),
    );
  });
});
