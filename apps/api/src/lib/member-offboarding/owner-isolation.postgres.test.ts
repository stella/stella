import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { member, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  contacts,
  flowRuns,
  flowRunSteps,
  searchHistoryEntries,
  searchProjectionRepairQueue,
  taskAssignees,
  workspaceMembers,
  workspaces,
  workObligations,
} from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { signInHuman } from "@/api/tests/helpers/human-session";

type RemovalFixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;

const readRemovalRows = async (db: GatedTestDb, fixture: RemovalFixture) => ({
  members: await db
    .select()
    .from(member)
    .where(eq(member.organizationId, fixture.organizationId))
    .orderBy(member.id),
  matters: await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, fixture.workspaceId)),
  matterMembers: await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, fixture.workspaceId))
    .orderBy(workspaceMembers.id),
  assignments: await db
    .select()
    .from(taskAssignees)
    .where(eq(taskAssignees.workspaceId, fixture.workspaceId))
    .orderBy(taskAssignees.id),
  obligations: await db
    .select()
    .from(workObligations)
    .where(eq(workObligations.workspaceId, fixture.workspaceId)),
  runs: await db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.workspaceId, fixture.workspaceId)),
  steps: await db
    .select()
    .from(flowRunSteps)
    .where(eq(flowRunSteps.workspaceId, fixture.workspaceId))
    .orderBy(flowRunSteps.id),
  contacts: await db
    .select()
    .from(contacts)
    .where(eq(contacts.organizationId, fixture.organizationId))
    .orderBy(contacts.id),
  repairs: await db
    .select()
    .from(searchProjectionRepairQueue)
    .where(
      eq(searchProjectionRepairQueue.organizationId, fixture.organizationId),
    ),
  history: await db
    .select()
    .from(searchHistoryEntries)
    .where(eq(searchHistoryEntries.organizationId, fixture.organizationId))
    .orderBy(searchHistoryEntries.id),
  audits: await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, fixture.organizationId))
    .orderBy(auditLogs.id),
});

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

describe.skipIf(!enabled)(
  "member removal organization isolation (postgres)",
  () => {
    test("root member removal retains other organizations' assignments and operation state", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const actor = await signInHuman(
          `removal-actor-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const departing = await signInHuman(
          `removal-member-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const actorUserId = brandPersistedUserId(actor.userId);
        const departingUserId = brandPersistedUserId(departing.userId);
        const a = await flowReviewGateFixture(db, {
          intermediate: false,
          governed: true,
        });
        const b = await flowReviewGateFixture(db, {
          intermediate: false,
          governed: true,
        });
        const aMemberId = mintAuthProviderIdValue();
        try {
          await mapWithConcurrency({
            items: [a, b],
            limit: 1,
            operation: async (fixture) => {
              await db.insert(member).values([
                {
                  id: fixture === a ? aMemberId : mintAuthProviderIdValue(),
                  organizationId: fixture.organizationId,
                  userId: departingUserId,
                  role: "member",
                  createdAt: new Date(),
                },
                {
                  id: mintAuthProviderIdValue(),
                  organizationId: fixture.organizationId,
                  userId: actorUserId,
                  role: "owner",
                  createdAt: new Date(),
                },
              ]);
              await db.insert(workspaceMembers).values([
                { workspaceId: fixture.workspaceId, userId: departingUserId },
                { workspaceId: fixture.workspaceId, userId: actorUserId },
              ]);
              await db
                .update(workspaces)
                .set({ leadUserId: departingUserId })
                .where(eq(workspaces.id, fixture.workspaceId));
              await db.insert(taskAssignees).values({
                entityId: fixture.taskEntityId,
                workspaceId: fixture.workspaceId,
                userId: departingUserId,
                role: "reviewer",
              });
              await db
                .update(workObligations)
                .set({
                  ownerUserId: departingUserId,
                  acknowledgedByUserId: departingUserId,
                })
                .where(eq(workObligations.entityId, fixture.taskEntityId));
              await db
                .update(flowRuns)
                .set({
                  triggerSource: { type: "manual", userId: departingUserId },
                })
                .where(eq(flowRuns.id, fixture.runId));
              await db.insert(contacts).values({
                id: createSafeId<"contact">(),
                organizationId: fixture.organizationId,
                type: "person",
                displayName: "Assignment fixture",
                responsibleAttorneyId: departingUserId,
                originatingAttorneyId: departingUserId,
              });
              await db.insert(searchHistoryEntries).values({
                id: createSafeId<"searchHistoryEntry">(),
                organizationId: fixture.organizationId,
                userId: departingUserId,
                kind: "search",
                lookupKey: "1".repeat(64),
                ciphertext: Buffer.from("fixture"),
                iv: Buffer.alloc(12),
              });
            },
          });
          const before = await readRemovalRows(db, b);
          expect(before.assignments).toHaveLength(1);
          expect(before.obligations.at(0)?.ownerUserId).toBe(departingUserId);
          expect(before.runs.at(0)?.status).toBe("awaiting_review");
          expect(before.contacts).toHaveLength(1);
          expect(before.history).toHaveLength(1);
          await getAuth().api.removeMember({
            body: {
              organizationId: a.organizationId,
              memberIdOrEmail: aMemberId,
            },
            headers: actor.headers(),
          });
          expect(await readRemovalRows(db, b)).toEqual(before);
          const remaining = await readRemovalRows(db, a);
          expect(
            remaining.members.some((row) => row.userId === departingUserId),
          ).toBe(false);
          expect(
            remaining.matterMembers.some(
              (row) => row.userId === departingUserId,
            ),
          ).toBe(false);
          expect(remaining.matters.at(0)?.leadUserId).toBeNull();
          expect(remaining.assignments).toHaveLength(0);
          expect(remaining.obligations.at(0)?.ownerUserId).toBeNull();
          expect(remaining.obligations.at(0)?.status).toBe("unassigned");
          expect(remaining.runs.at(0)?.status).toBe("cancelled");
          expect(remaining.steps).toHaveLength(1);
          expect(remaining.steps.every((row) => row.status === "skipped")).toBe(
            true,
          );
          expect(remaining.contacts.at(0)?.responsibleAttorneyId).toBeNull();
          expect(remaining.contacts.at(0)?.originatingAttorneyId).toBeNull();
          expect(remaining.repairs).toHaveLength(1);
          expect(remaining.history).toHaveLength(0);
          expect(
            remaining.audits.some(
              (row) => row.metadata?.["change"] === "member-removed",
            ),
          ).toBe(true);
        } finally {
          await b.cleanup();
          await a.cleanup();
          await db.delete(user).where(eq(user.id, departingUserId));
          await db.delete(user).where(eq(user.id, actorUserId));
        }
      });
    }, 60_000);
  },
);
