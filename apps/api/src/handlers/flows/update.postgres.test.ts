import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { deferred, settledWithin } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { auditLogs, flowDefinitions, schedulerJobs } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "@/api/lib/scheduler/flow-schedule-identity";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";
import { writeScalingViolations } from "@/api/tests/read-scaling/measurement";

import getFlowDefinition from "./get";
import { updateFlowDefinitionBodySchema } from "./schema";
import type { flowDefinitionBodySchema } from "./schema";
import updateFlowDefinition from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const initialToken = "2099-01-01T00:00:00.000Z";
const original = {
  name: "Original workflow",
  description: "Original description",
  steps: [
    {
      kind: "review-gate",
      name: "Review",
      instructions: "Check the document.",
    },
  ],
  trigger: { type: "manual" },
  enabled: false,
} satisfies v.InferInput<typeof flowDefinitionBodySchema>;

type Fixture = {
  db: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  id: ReturnType<typeof createSafeId<"flowDefinition">>;
  organizationId: ReturnType<typeof mintAuthProviderId<"organization">>;
  userId: ReturnType<typeof mintAuthProviderId<"user">>;
  read: () => ReturnType<typeof getFlowDefinition.handler>;
  write: (
    body: v.InferOutput<typeof updateFlowDefinitionBodySchema>,
    database?: GatedTestDb,
    audit?: AuditRecorder,
  ) => ReturnType<typeof updateFlowDefinition.handler>;
  row: () => Promise<typeof flowDefinitions.$inferSelect>;
  audits: () => Promise<(typeof auditLogs.$inferSelect)[]>;
  audit: AuditRecorder;
};

if (!runPostgres || !databaseUrl) {
  describe.skip("workflow replacement versions", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const id = createSafeId<"flowDefinition">();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      try {
        await db.insert(user).values({
          id: userId,
          name: "Workflow editor",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(organization).values({
          id: organizationId,
          name: "Workflow editing",
          slug: organizationId,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        await db
          .insert(flowDefinitions)
          .values({
            id,
            organizationId,
            ...original,
            updatedAt: new Date(initialToken),
          });
        const audit = createAuditRecorder({
          organizationId,
          workspaceId: null,
          userId,
          request: new Request("https://example.test/v1/flows"),
          server: null,
        });
        const safeDb = (database: GatedTestDb) =>
          createSafeDb(markRlsDatabase(database), [], organizationId, userId);
        const read = async () =>
          await getFlowDefinition.handler(
            createTestHandlerContext<
              Parameters<typeof getFlowDefinition.handler>[0]
            >({
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              params: { flowId: id },
              safeDb: safeDb(db),
              scopedDb: NO_DB,
              audit,
            }),
          );
        const write: Fixture["write"] = async (
          body,
          database = db,
          recorder = audit,
        ) =>
          await updateFlowDefinition.handler(
            createTestHandlerContext<
              Parameters<typeof updateFlowDefinition.handler>[0]
            >({
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              params: { flowId: id },
              body,
              safeDb: safeDb(database),
              scopedDb: NO_DB,
              audit: recorder,
            }),
          );
        await run({
          db,
          openClient,
          id,
          organizationId,
          userId,
          read,
          write,
          audit,
          row: async () =>
            (
              await db
                .select()
                .from(flowDefinitions)
                .where(eq(flowDefinitions.id, id))
            ).at(0) ?? panic("Workflow fixture disappeared"),
          audits: async () =>
            await db
              .select()
              .from(auditLogs)
              .where(eq(auditLogs.resourceId, id)),
        });
      } finally {
        await db
          .delete(schedulerJobs)
          .where(eq(schedulerJobs.id, flowScheduleJobId(id)));
        await deleteOrganizationsForTest(db, [organizationId]);
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  };

  describe("workflow replacement versions", () => {
    test("read, schema admission, replacement and read-back share one advancing editor token", async () => {
      await withFixture(async ({ read, write, row, audits, id }) => {
        const before = await read();
        if (before instanceof HttpStatusResponse) {
          panic("Workflow read must succeed");
        }
        const body = v.parse(updateFlowDefinitionBodySchema, {
          ...before,
          name: "  Updated workflow  ",
          description: "Updated description",
          steps: [
            {
              kind: "create-document",
              name: "File",
              documentTitle: "Approved memo",
            },
          ],
          enabled: true,
          expectedUpdatedAt: before.updatedAt,
        });
        const answer = await write(body);
        const after = await read();
        if (after instanceof HttpStatusResponse) {
          panic("Updated workflow read must succeed");
        }
        expect(answer).toEqual({ id, updatedAt: "2099-01-01T00:00:00.001Z" });
        expect(after).toMatchObject({
          name: "Updated workflow",
          description: body.description,
          steps: body.steps,
          enabled: true,
          trigger: body.trigger,
          updatedAt: "2099-01-01T00:00:00.001Z",
        });
        const current = await row();
        const recorded = await audits();
        expect(recorded).toMatchObject([
          {
            action: AUDIT_ACTION.UPDATE,
            changes: {
              fields: {
                old: null,
                new: ["name", "description", "steps", "trigger", "enabled"],
              },
            },
          },
        ]);
        expect(recorded).toHaveLength(1);
        expect(await write(body)).toMatchObject({
          code: 409,
          response: { code: API_VERSION_CONFLICT_ERROR_CODE },
        });
        expect(await row()).toEqual(current);
        expect(await audits()).toEqual(recorded);
        const next = v.parse(updateFlowDefinitionBodySchema, {
          ...after,
          expectedUpdatedAt: after.updatedAt,
        });
        expect(await write(next)).toEqual({
          id,
          updatedAt: "2099-01-01T00:00:00.002Z",
        });
      });
    });

    test("stale replacement leaves definition, audit and pending scheduler reconciliation untouched", async () => {
      await withFixture(async ({ db, id, row, audits, write }) => {
        await db.insert(schedulerJobs).values({
          id: flowScheduleJobId(id),
          task: FLOW_RUN_TASK,
          schedule: { type: "daily", hour: 12, minute: 0, timeZone: "UTC" },
          nextRunAt: new Date(initialToken),
          payload: { definitionId: id },
        });
        const before = await row();
        const jobs = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, flowScheduleJobId(id)));
        expect(jobs).toHaveLength(1);
        expect(
          await write({
            ...original,
            name: "Stale replacement",
            expectedUpdatedAt: "2098-01-01T00:00:00.000Z",
          }),
        ).toMatchObject({
          code: 409,
          response: { code: API_VERSION_CONFLICT_ERROR_CODE },
        });
        expect(await row()).toEqual(before);
        expect(await audits()).toEqual([]);
        expect(
          await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, flowScheduleJobId(id))),
        ).toEqual(jobs);
      });
    });

    test("audit transaction abort rolls back the definition and token before scheduler reconciliation", async () => {
      await withFixture(async ({ write, row, audits, audit }) => {
        const before = await row();
        let aborted = false;
        const answer = await write(
          {
            ...original,
            name: "Must roll back",
            expectedUpdatedAt: initialToken,
          },
          undefined,
          async (tx, event) => {
            await audit(tx, event);
            aborted = true;
            tx.rollback();
          },
        );
        expect(aborted).toBe(true);
        expect(answer).toMatchObject({ code: 500 });
        expect(await row()).toEqual(before);
        expect(await audits()).toEqual([]);
      });
    });

    test("waiting editors compare against the committed winner after the definition lock", async () => {
      await withFixture(async ({ db, openClient, id, write, row, audits }) => {
        const holder = openClient({ max: 1 });
        const first = openClient({ max: 1 });
        const second = openClient({ max: 1 });
        const observer = openClient();
        const pid = async (client: typeof holder) =>
          (
            await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`
          ).at(0)?.pid ?? panic("Editor needs a backend");
        const holdingPid = await pid(holder);
        const firstPid = await pid(first);
        const secondPid = await pid(second);
        const locked = deferred();
        const release = deferred();
        const held = holder.db.transaction(async (tx) => {
          await tx
            .select()
            .from(flowDefinitions)
            .where(eq(flowDefinitions.id, id))
            .for("update");
          locked.resolve();
          await release.promise;
        });
        const writes: ReturnType<typeof write>[] = [];
        try {
          await settledWithin(locked.promise, {
            description: "the separate definition barrier to hold the row",
          });
          writes.push(
            write(
              {
                ...original,
                name: "Winning editor",
                expectedUpdatedAt: initialToken,
              },
              first.db,
            ),
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: firstPid,
            holdingPid,
          });
          writes.push(
            write(
              {
                ...original,
                name: "Waiting editor",
                expectedUpdatedAt: initialToken,
              },
              second.db,
            ),
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: secondPid,
            holdingPid: firstPid,
          });
          release.resolve();
          await held;
          const answers = await settledWithin(Promise.all(writes), {
            description:
              "both real editor transactions and post-commit reconciliation to finish",
          });
          expect(answers).toMatchObject([
            { id, updatedAt: "2099-01-01T00:00:00.001Z" },
            { code: 409, response: { code: API_VERSION_CONFLICT_ERROR_CODE } },
          ]);
          expect((await row()).name).toBe("Winning editor");
          expect(await audits()).toHaveLength(1);
          expect(
            await db
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, flowScheduleJobId(id))),
          ).toEqual([]);
        } finally {
          release.resolve();
          await held;
          await Promise.all(writes);
        }
      });
    });

    test.each(["missing", "other organization"] as const)(
      "keeps %s definitions outside the replacement scope",
      async (scope) => {
        await withFixture(async ({ db, id, organizationId, userId, audit }) => {
          const targetId = createSafeId<"flowDefinition">();
          const otherOrganizationId = mintAuthProviderId<"organization">();
          try {
            if (scope === "other organization") {
              await db.insert(organization).values({
                id: otherOrganizationId,
                name: "Other workflow editing",
                slug: otherOrganizationId,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
              });
              await db.insert(flowDefinitions).values({
                ...original,
                id: targetId,
                organizationId: otherOrganizationId,
                updatedAt: new Date(initialToken),
              });
            }
            await db.insert(schedulerJobs).values({
              id: flowScheduleJobId(targetId),
              task: FLOW_RUN_TASK,
              schedule: { type: "daily", hour: 12, minute: 0, timeZone: "UTC" },
              nextRunAt: new Date(initialToken),
              payload: { definitionId: targetId },
            });
            const before = await db
              .select()
              .from(flowDefinitions)
              .where(eq(flowDefinitions.id, targetId));
            const jobs = await db
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, flowScheduleJobId(targetId)));
            expect(jobs).toHaveLength(1);
            expect(before).toHaveLength(scope === "missing" ? 0 : 1);
            const answer = await updateFlowDefinition.handler(
              createTestHandlerContext<
                Parameters<typeof updateFlowDefinition.handler>[0]
              >({
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                params: { flowId: targetId },
                body: {
                  ...original,
                  name: "Must not replace",
                  expectedUpdatedAt: initialToken,
                },
                safeDb: createSafeDb(
                  markRlsDatabase(db),
                  [],
                  organizationId,
                  userId,
                ),
                scopedDb: NO_DB,
                audit,
              }),
            );
            expect(answer).toMatchObject({
              code: 404,
              response: { message: "Flow not found" },
            });
            expect(
              await db
                .select()
                .from(flowDefinitions)
                .where(eq(flowDefinitions.id, targetId)),
            ).toEqual(before);
            expect(
              await db
                .select()
                .from(auditLogs)
                .where(eq(auditLogs.resourceId, targetId)),
            ).toEqual([]);
            expect(
              await db
                .select()
                .from(schedulerJobs)
                .where(eq(schedulerJobs.id, flowScheduleJobId(targetId))),
            ).toEqual(jobs);
            const current =
              (
                await db
                  .select()
                  .from(flowDefinitions)
                  .where(eq(flowDefinitions.id, id))
              ).at(0) ?? panic("Original workflow fixture disappeared");
            expect(current.name).toBe(original.name);
          } finally {
            await db
              .delete(schedulerJobs)
              .where(eq(schedulerJobs.id, flowScheduleJobId(targetId)));
            if (scope === "other organization") {
              await deleteOrganizationsForTest(db, [otherOrganizationId]);
            }
          }
        });
      },
    );

    test("replacement work stays constant with twenty and two hundred peer definitions", async () => {
      await withFixture(async ({ db, organizationId, read, write }) => {
        const peers = (count: number) =>
          Array.from({ length: count }, () => ({
            ...original,
            id: createSafeId<"flowDefinition">(),
            organizationId,
          }));
        await db.insert(flowDefinitions).values(peers(20));
        const measure = async () => {
          const current = await read();
          if (current instanceof HttpStatusResponse) {
            panic("Scaling requires the actual workflow read");
          }
          const body = v.parse(updateFlowDefinitionBodySchema, {
            ...current,
            expectedUpdatedAt: current.updatedAt,
          });
          return await runWithMeasuredQueryCounter(async (counter) => {
            const answer = await write(body);
            expect(answer).not.toBeInstanceOf(HttpStatusResponse);
            return {
              statements: counter.count,
              transactionRoundTrips: counter.transactions,
              responseBytes: Buffer.byteLength(JSON.stringify(answer)),
            };
          });
        };
        const small = await measure();
        await db.insert(flowDefinitions).values(peers(180));
        const large = await measure();
        expect(small.statements).toBeGreaterThan(0);
        expect(small.transactionRoundTrips).toBeGreaterThan(0);
        expect(writeScalingViolations({ small, large })).toEqual([]);
      });
    });
  });
}
