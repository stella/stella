import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { recoverOrphanedMatterSteward } from "@/api/lib/workspaces/visibility";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const createdIds: SafeId<"workspace">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterEach(async () => {
  if (createdIds.length > 0) {
    await testDb.delete(workspaces).where(inArray(workspaces.id, createdIds));
  }
  createdIds.length = 0;
});
afterAll(releaseRlsFixture);

const createOrphan = async (tx: Transaction) => {
  // The deferred creation constraint permits naming and assigning a steward
  // in the same transaction; recovery must satisfy it before commit.
  const workspaceId = createSafeId<"workspace">();
  await tx.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: "Recovery matter",
    reference: workspaceId,
    visibility: "assigned_only",
    leadUserId: null,
  });
  return workspaceId;
};

const refuseStatus = (error: unknown, status: number) => {
  expect(HandlerError.is(error)).toBe(true);
  if (!HandlerError.is(error)) {
    throw new TypeError("Expected a recovery refusal");
  }
  expect(error.status).toBe(status);
};

test("explicit recovery assigns only the named internal steward and preserves private visibility", async () => {
  const events: AuditEvent[] = [];
  const recordAuditEvent: AuditRecorder = (_tx, event) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  const workspaceId = await testDb.transaction(async (rawTx) => {
    const tx = asTestRaw<Transaction>(rawTx);
    const id = await createOrphan(tx);
    await recoverOrphanedMatterSteward(tx, {
      organizationId: ids.orgA,
      workspaceId: id,
      actorUserId: ids.userAdmin,
      stewardUserId: ids.userA2,
      recordAuditEvent,
    });
    return id;
  });
  createdIds.push(workspaceId);
  const matter = await testDb
    .select({
      visibility: workspaces.visibility,
      leadUserId: workspaces.leadUserId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  expect(matter).toEqual([
    { visibility: "assigned_only", leadUserId: ids.userA2 },
  ]);
  const assignments = await testDb
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  expect(assignments).toEqual([{ userId: ids.userA2 }]);
  for (const [userId, canRead] of [
    [ids.userAdmin, false],
    [ids.userA1, false],
    [ids.userA2, true],
  ] as const) {
    const access = await testDb
      .select({
        canRead: memberReachesMatterSql(
          { organizationId: ids.orgA, userId },
          workspaceId,
        ),
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(access).toEqual([{ canRead }]);
  }
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(event.workspaceId).toBe(workspaceId);
  }
  expect(events.at(-1)).toMatchObject({
    changes: { leadUserId: { old: null, new: ids.userA2 } },
  });
});

test.each(["actor", "steward", "external-steward"] as const)(
  "recovery refuses an unauthorized %s before granting any access",
  async (invalid) => {
    const events: AuditEvent[] = [];
    const error = await rejectionOf(
      testDb.transaction(async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const workspaceId = await createOrphan(tx);
        if (invalid === "external-steward") {
          await tx.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: ids.orgA,
            userId: ids.userB1,
            role: "external",
            createdAt: new Date(),
          });
        }
        await recoverOrphanedMatterSteward(tx, {
          organizationId: ids.orgA,
          workspaceId,
          actorUserId: invalid === "actor" ? ids.userA1 : ids.userAdmin,
          stewardUserId: invalid !== "actor" ? ids.userB1 : ids.userA2,
          recordAuditEvent: (_tx, event) => {
            events.push(...(Array.isArray(event) ? event : [event]));
          },
        });
      }),
    );
    refuseStatus(error, invalid === "actor" ? 403 : 400);
    expect(events).toEqual([]);
  },
);

test.each(["unknown", "other-organization", "healthy"] as const)(
  "recovery refuses a %s matter without changing its steward",
  async (target) => {
    const workspaceId = {
      unknown: createSafeId<"workspace">(),
      "other-organization": ids.wsB1,
      healthy: ids.wsA1,
    }[target];
    const before = await testDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const events: AuditEvent[] = [];
    const error = await rejectionOf(
      testDb.transaction(async (rawTx) => {
        await recoverOrphanedMatterSteward(asTestRaw<Transaction>(rawTx), {
          organizationId: ids.orgA,
          workspaceId,
          actorUserId: ids.userAdmin,
          stewardUserId: ids.userA2,
          recordAuditEvent: (_tx, event) => {
            events.push(...(Array.isArray(event) ? event : [event]));
          },
        });
      }),
    );
    refuseStatus(error, target === "healthy" ? 409 : 404);
    expect(events).toEqual([]);
    expect(
      await testDb
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId)),
    ).toEqual(before);
  },
);
