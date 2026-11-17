import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";
import { deferred, settledWithin } from "@stll/test-kit";

import { organization } from "@/api/db/auth-schema";
import { flowDefinitions, schedulerJobs, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { AggregateIdentities } from "@/api/lib/db/aggregate-lock-entries/identities.gen";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { FLOW_RUN_TASK, flowScheduleJobId } from "./flow-schedule-identity";
import {
  removeOrphanedFlowSchedule,
  withFlowScheduleTransaction,
} from "./flow-schedule-transaction";
import { reconcileCommittedFlowSchedule } from "./jobs";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type Fixture = {
  db: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  identity: AggregateIdentities["definition"];
  nextOrganizationId: SafeId<"organization">;
  nextWorkspaceId: SafeId<"workspace">;
};

if (!runPostgres || !databaseUrl) {
  describe.skip("flow schedule current state", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const nextOrganizationId = mintAuthProviderId<"organization">();
      const workspaceId = createSafeId<"workspace">();
      const nextWorkspaceId = createSafeId<"workspace">();
      const id = createSafeId<"flowDefinition">();
      try {
        await db.insert(organization).values(
          [organizationId, nextOrganizationId].map((orgId) => ({
            id: orgId,
            name: "Schedule reconciliation",
            slug: orgId,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          })),
        );
        await db.insert(workspaces).values([
          {
            id: workspaceId,
            organizationId,
            name: "Original matter",
            reference: "ORIGINAL",
          },
          {
            id: nextWorkspaceId,
            organizationId: nextOrganizationId,
            name: "Current matter",
            reference: "CURRENT",
          },
        ]);
        await db.insert(flowDefinitions).values({
          id,
          organizationId,
          name: "Scheduled flow",
          steps: [
            {
              kind: "ai",
              name: "Draft memo",
              prompt: "Draft a short memo.",
              includeDocuments: false,
            },
          ],
          enabled: true,
          trigger: {
            type: "schedule",
            workspaceId,
            schedule: { frequency: "daily", hourUtc: 12 },
          },
        });
        await run({
          db,
          openClient,
          identity: { id, organizationId },
          nextOrganizationId,
          nextWorkspaceId,
        });
      } finally {
        await db
          .delete(schedulerJobs)
          .where(eq(schedulerJobs.id, flowScheduleJobId(id)));
        await deleteOrganizationsForTest(db, [
          organizationId,
          nextOrganizationId,
        ]);
      }
    });
  };

  describe("flow schedule current state", () => {
    test.each([false, true])(
      "repeated reconciliation uses current enabled=%s",
      async (enabled) => {
        await withFixture(async ({ db, identity }) => {
          await reconcileCommittedFlowSchedule(identity);
          await db
            .update(flowDefinitions)
            .set({ enabled })
            .where(eq(flowDefinitions.id, identity.id));
          await reconcileCommittedFlowSchedule(identity);
          await reconcileCommittedFlowSchedule(identity);
          const row = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          });
          if (enabled) {
            expect(row).toMatchObject({ task: FLOW_RUN_TASK, enabled: true });
          } else {
            expect(row).toBeUndefined();
          }
        });
      },
    );

    test("an ordinary post-commit reconciliation rereads after waiting on its fence", async () => {
      await withFixture(async ({ db, identity, openClient }) => {
        await db
          .update(flowDefinitions)
          .set({ enabled: false })
          .where(eq(flowDefinitions.id, identity.id));
        await reconcileCommittedFlowSchedule(identity);
        expect(
          await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          }),
        ).toBeUndefined();
        const blocker = openClient({ max: 1 });
        const observer = openClient();
        const [holder] = await blocker.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        if (!holder) {
          panic("The post-commit reconciliation barrier must have a session");
        }
        const held = deferred();
        const release = deferred();
        const launched: Promise<void>[] = [];
        try {
          launched.push(
            withFlowScheduleTransaction(
              { database: blocker.db, definitionId: identity.id },
              async () => {
                held.resolve();
                await release.promise;
              },
            ),
          );
          await settledWithin(held.promise, {
            description: "the committed-state barrier to own the fence",
          });
          launched.push(reconcileCommittedFlowSchedule(identity));
          const waiting = await waitForExternalState({
            description:
              "the actual scheduler reconciliation backend to wait on the definition fence",
            read: async () => {
              const rows = await observer.sql<{ pid: number }[]>`
                select pid from pg_stat_activity
                where ${holder.pid} = any(pg_blocking_pids(pid))
                  and application_name like 'stella-root-%'
              `;
              return rows.at(0);
            },
          });
          expect(waiting.pid).not.toBe(holder.pid);
          await db
            .update(flowDefinitions)
            .set({ enabled: true })
            .where(eq(flowDefinitions.id, identity.id));
          release.resolve();
          await Promise.all(launched);
          expect(
            await db.query.schedulerJobs.findFirst({
              where: { id: { eq: flowScheduleJobId(identity.id) } },
            }),
          ).toMatchObject({
            enabled: true,
            schedule: { type: "daily", hour: 12, minute: 0, timeZone: "UTC" },
          });
        } finally {
          release.resolve();
          await Promise.allSettled(launched);
        }
      });
    });

    test("a stale organization leaves the current same-ID owner's job alone", async () => {
      await withFixture(
        async ({ db, identity, nextOrganizationId, nextWorkspaceId }) => {
          await reconcileCommittedFlowSchedule(identity);
          await db
            .update(flowDefinitions)
            .set({
              organizationId: nextOrganizationId,
              trigger: {
                type: "schedule",
                workspaceId: nextWorkspaceId,
                schedule: { frequency: "daily", hourUtc: 18 },
              },
            })
            .where(eq(flowDefinitions.id, identity.id));
          await reconcileCommittedFlowSchedule({
            id: identity.id,
            organizationId: nextOrganizationId,
          });
          const before = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          });
          expect(before).toMatchObject({
            task: FLOW_RUN_TASK,
            schedule: { hour: 18 },
          });
          await reconcileCommittedFlowSchedule(identity);
          const after = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          });
          expect(after).toEqual(before);
        },
      );
    });

    test("a blocked orphan cleanup preserves a same-ID definition that reappears", async () => {
      await withFixture(async ({ db, identity, openClient }) => {
        await reconcileCommittedFlowSchedule(identity);
        const [original] = await db
          .delete(flowDefinitions)
          .where(eq(flowDefinitions.id, identity.id))
          .returning();
        if (!original) {
          panic("The original definition must exist before recreation");
        }
        expect(
          await db.query.flowDefinitions.findFirst({
            where: { id: { eq: identity.id } },
          }),
        ).toBeUndefined();
        const before = await db.query.schedulerJobs.findFirst({
          where: { id: { eq: flowScheduleJobId(identity.id) } },
        });
        expect(before).toMatchObject({ task: FLOW_RUN_TASK, enabled: true });
        const blocker = openClient({ max: 1 });
        const cleanup = openClient({ max: 1 });
        const observer = openClient();
        const [holder] = await blocker.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        const [waiter] = await cleanup.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        if (!holder || !waiter) {
          panic("The orphan cleanup sessions must exist");
        }
        const held = deferred();
        const release = deferred();
        const launched: Promise<void>[] = [];
        try {
          launched.push(
            withFlowScheduleTransaction(
              { database: blocker.db, definitionId: identity.id },
              async () => {
                held.resolve();
                await release.promise;
              },
            ),
          );
          await settledWithin(held.promise, {
            description: "the recreation barrier to own the definition fence",
          });
          launched.push(
            removeOrphanedFlowSchedule({
              database: cleanup.db,
              definitionId: identity.id,
            }),
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: waiter.pid,
            holdingPid: holder.pid,
          });
          await db.insert(flowDefinitions).values(original);
          release.resolve();
          await Promise.all(launched);
          expect(
            await db.query.schedulerJobs.findFirst({
              where: { id: { eq: flowScheduleJobId(identity.id) } },
            }),
          ).toEqual(before);
        } finally {
          release.resolve();
          await Promise.allSettled(launched);
        }
      });
    });

    test("a genuinely deleted definition removes its job through either entrypoint", async () => {
      await withFixture(async ({ db, identity }) => {
        await reconcileCommittedFlowSchedule(identity);
        const job =
          (await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          })) ?? panic("The definition must have a job before deletion");
        await db
          .delete(flowDefinitions)
          .where(eq(flowDefinitions.id, identity.id));
        await removeOrphanedFlowSchedule({
          database: db,
          definitionId: identity.id,
        });
        expect(
          await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          }),
        ).toBeUndefined();
        await db.insert(schedulerJobs).values(job);
        expect(
          await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          }),
        ).toEqual(job);
        await reconcileCommittedFlowSchedule(identity);
        expect(
          await db.query.schedulerJobs.findFirst({
            where: { id: { eq: flowScheduleJobId(identity.id) } },
          }),
        ).toBeUndefined();
      });
    });
  });
}
