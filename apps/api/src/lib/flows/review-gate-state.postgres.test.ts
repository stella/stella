import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, flowRuns, flowRunSteps, workspaces } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  cancelFlowRun,
  resolveFlowReviewGate,
} from "@/api/lib/flows/flow-executor";
import type { FlowStep } from "@/api/lib/flows/flow-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ACTIONS = ["approved", "rejected", "cancel"] as const;
type Action = (typeof ACTIONS)[number];

const fixture = async (db: GatedTestDb, intermediate: boolean) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const runId = createSafeId<"flowRun">();
  const taskEntityId = createSafeId<"entity">();
  const steps = [{ kind: "review-gate", name: "Review" }] satisfies FlowStep[];
  if (intermediate) {
    steps.push({ kind: "review-gate", name: "Next review" });
  }
  const cleanup = async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Review fixture",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values({
      id: userId,
      name: "Reviewer",
      email: `${userId}@example.test`,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Review matter",
      reference: workspaceId,
    });
    await db.insert(entities).values({
      id: taskEntityId,
      workspaceId,
      kind: "task",
      name: "Review task",
      status: "open",
    });
    await db.insert(flowRuns).values({
      id: runId,
      workspaceId,
      status: "awaiting_review",
      definitionSnapshot: { name: "Review flow", steps },
      triggerSource: { type: "manual", userId },
    });
    await db.insert(flowRunSteps).values(
      steps.map((step, index) => ({
        id: createSafeId<"flowRunStep">(),
        workspaceId,
        runId,
        index,
        kind: step.kind,
        reviewTaskEntityId: index === 0 ? taskEntityId : null,
        status:
          index === 0 ? ("awaiting_review" as const) : ("pending" as const),
      })),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "system", source: "review_gate_test" },
    },
  });
  const enqueued: number[] = [];
  let actionIndex = 0;
  const act = async (safeDb: SafeDb, action: Action) => {
    const note = `${action}:${actionIndex}`;
    actionIndex += 1;
    return action === "cancel"
      ? await cancelFlowRun({
          safeDb,
          workspaceId,
          runId,
          userId,
          recordAuditEvent,
        })
      : await resolveFlowReviewGate(
          {
            safeDb,
            workspaceId,
            organizationId,
            runId,
            userId,
            recordAuditEvent,
            decision: action,
            note,
          },
          {
            broadcastUpdate: () => undefined,
            enqueueStep: async ({ stepIndex }) => {
              enqueued.push(stepIndex);
            },
            notifyRunCompleted: async () => undefined,
          },
        );
  };
  const read = async () => ({
    task: await db.query.entities.findFirst({
      where: { id: { eq: taskEntityId } },
    }),
    run: await db.query.flowRuns.findFirst({ where: { id: { eq: runId } } }),
    steps: await db.query.flowRunSteps.findMany({
      where: { runId: { eq: runId } },
      orderBy: { index: "asc" },
    }),
  });
  return { organizationId, userId, workspaceId, enqueued, act, read, cleanup };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("review gate state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review gate state (postgres)", () => {
    for (const intermediate of [false, true]) {
      for (const winner of ACTIONS) {
        for (const loser of ACTIONS) {
          test(`${intermediate ? "intermediate" : "final"} gate: ${winner} commits before ${loser}`, async () => {
            await withGatedTestClients(databaseUrl, async ({ openClient }) => {
              const { db } = openClient();
              const { sql: otherClient } = openClient();
              const f = await fixture(db, intermediate);
              const firstDb = createSafeDb(
                markRlsDatabase(db),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              const written = Promise.withResolvers<undefined>();
              const release = Promise.withResolvers<undefined>();
              const otherDb = drizzle({
                client: otherClient,
                relations: databaseRelations,
                logger: {
                  logQuery: (query) => {
                    // Release at the decisive lock request. Without locking,
                    // release at UPDATE instead, after all stale reads have
                    // finished; a nonlocking mutation must fail this matrix.
                    if (
                      query.includes("for update") ||
                      /^update "flow_(runs|run_steps)"/u.test(query)
                    ) {
                      release.resolve(undefined);
                    }
                  },
                },
              });
              const secondDb = createSafeDb(
                markRlsDatabase(otherDb),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              const gatedFirst: SafeDb = async (work, retry) =>
                await firstDb(async (tx) => {
                  const value = await work(tx);
                  if (
                    typeof value === "object" &&
                    value !== null &&
                    ("payload" in value || "steps" in value)
                  ) {
                    written.resolve(undefined);
                    await release.promise;
                  }
                  return value;
                }, retry);
              try {
                const winning = f.act(gatedFirst, winner);
                await Promise.race([
                  written.promise,
                  winning.then((result) => {
                    if (result.isErr()) {
                      throw result.error;
                    }
                    throw new Error(
                      "The winning action finished without reaching its commit barrier",
                    );
                  }),
                ]);
                const losing = f.act(secondDb, loser);
                const [won, lost] = await Promise.all([winning, losing]);
                expect(won.isOk()).toBe(true);
                expect(lost.isErr()).toBe(true);
                if (lost.isErr()) {
                  expect(HandlerError.is(lost.error)).toBe(true);
                  expect(lost.error).toMatchObject({
                    status: 409,
                    message:
                      loser === "cancel"
                        ? "This run changed before it could be cancelled."
                        : "This run is not awaiting review.",
                  });
                }
                const state = await f.read();
                const gate = state.steps.at(0);
                const approvedStatus = intermediate ? "running" : "completed";
                expect(state.run?.status).toBe(
                  winner === "approved" ? approvedStatus : "cancelled",
                );
                expect(state.task?.status).toBe(
                  winner === "cancel" ? "cancelled" : "done",
                );
                expect(gate?.status).toBe(
                  winner === "cancel" ? "skipped" : "completed",
                );
                expect(gate?.output).toEqual(
                  winner === "cancel"
                    ? null
                    : {
                        kind: "review-gate",
                        decision: winner,
                        userId: f.userId,
                        note: `${winner}:0`,
                      },
                );
                expect(f.enqueued).toEqual(
                  winner === "approved" && intermediate ? [1] : [],
                );
                if (intermediate) {
                  expect(state.steps.at(1)?.status).toBe(
                    winner === "approved" ? "pending" : "skipped",
                  );
                }
                for (const action of ACTIONS.filter(
                  (candidate) => candidate !== "cancel",
                )) {
                  expect((await f.act(secondDb, action)).isErr()).toBe(true);
                  expect(await f.read()).toEqual(state);
                }
              } finally {
                release.resolve(undefined);
                await f.cleanup();
              }
            });
          });
        }
      }
    }
    test("review gate first committed terminal action is immutable", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await assertProperty(
          "review gate first committed terminal action is immutable",
          fc.asyncProperty(
            fc.array(fc.constantFrom(...ACTIONS), {
              minLength: 1,
              maxLength: 12,
            }),
            async (actions) => {
              const f = await fixture(db, false);
              const safeDb = createSafeDb(
                markRlsDatabase(db),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              try {
                const first = actions.at(0);
                if (!first) {
                  throw new Error("Expected a first action");
                }
                expect((await f.act(safeDb, first)).isOk()).toBe(true);
                const state = await f.read();
                expect(state.run?.status).toBe(
                  first === "approved" ? "completed" : "cancelled",
                );
                expect(state.steps.at(0)?.output).toEqual(
                  first === "cancel"
                    ? null
                    : {
                        kind: "review-gate",
                        decision: first,
                        userId: f.userId,
                        note: `${first}:0`,
                      },
                );
                for (const action of actions.slice(1)) {
                  expect((await f.act(safeDb, action)).isErr()).toBe(true);
                  expect(await f.read()).toEqual(state);
                }
                expect(f.enqueued).toEqual([]);
              } finally {
                await f.cleanup();
              }
            },
          ),
          { numRuns: 20 },
        );
      });
    });
  });
}
