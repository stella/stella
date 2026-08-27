import { describe, expect, test } from "bun:test";

import {
  auditLogs,
  entities,
  taskAssignees,
  WORK_OBLIGATION_STATUS,
  workObligations,
  workspaceMembers,
} from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateWorkObligation from "./update";

type UpdateContext = Parameters<typeof updateWorkObligation.handler>[0];

describe("updateWorkObligation", () => {
  test("locks the delegated owner's membership before the obligation", async () => {
    const workspaceId = toSafeId<"workspace">(
      "0198fa3d-fc8d-7000-8000-000000000001",
    );
    const entityId = toSafeId<"entity">("0198fa3d-fc8d-7000-8000-000000000002");
    const actorUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000003",
    );
    const previousOwnerUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000004",
    );
    const nextOwnerUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000005",
    );
    const lockOrder: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => ({
              for: async () => {
                lockOrder.push(table);
                if (table === workspaceMembers) {
                  return [{ userId: nextOwnerUserId }];
                }
                return [
                  {
                    entityId,
                    workspaceId,
                    ownerUserId: previousOwnerUserId,
                    status: WORK_OBLIGATION_STATUS.ACTIVE,
                    acknowledgedAt: new Date(),
                    acknowledgedByUserId: previousOwnerUserId,
                    type: "task",
                    workingTargetDate: null,
                    hardDeadlineDate: null,
                    sourceType: "manual",
                    sourceEntityId: null,
                    sourceDescription: null,
                  },
                ];
              },
            }),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ entityId }] }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async () => {
          if (table === auditLogs) {
            return;
          }
        },
      }),
    });
    const request = new Request("https://api.example.test/work-obligations");
    const recordAuditEvent = createAuditRecorder({
      organizationId: toSafeId<"organization">(
        "0198fa3d-fc8d-7000-8000-000000000006",
      ),
      workspaceId,
      userId: actorUserId,
      request,
      server: null,
    });

    const result = await updateWorkObligation.handler(
      asTestRaw<UpdateContext>({
        body: { ownerUserId: nextOwnerUserId, reason: "Coverage handoff" },
        createAuditRecorder: () => recordAuditEvent,
        memberRole: { role: "owner" },
        orgAIConfig: null,
        params: { workspaceId, entityId },
        recordAuditEvent,
        request,
        safeDb,
        scopedDb,
        session: {
          activeOrganizationId: toSafeId<"organization">(
            "0198fa3d-fc8d-7000-8000-000000000006",
          ),
        },
        user: { id: actorUserId },
        workspaceId,
      }),
    );

    expect(result).toEqual({ success: true });
    expect(lockOrder).toEqual([workspaceMembers, workObligations]);
  });

  test("initializes a legacy task before updating its working target", async () => {
    const workspaceId = toSafeId<"workspace">(
      "0198fa3d-fc8d-7000-8000-000000000011",
    );
    const entityId = toSafeId<"entity">("0198fa3d-fc8d-7000-8000-000000000012");
    const actorUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000013",
    );
    const createdAt = new Date("2026-08-01T00:00:00Z");
    let obligationReadCount = 0;
    let insertedLegacyObligation = false;

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => {
          if (table === taskAssignees) {
            return {
              innerJoin: () => ({
                where: () => ({
                  limit: () => ({ for: async () => [] }),
                }),
              }),
            };
          }
          return {
            where: () => ({
              limit: () => ({
                for: async () => {
                  if (table === entities) {
                    return [
                      {
                        id: entityId,
                        workspaceId,
                        agendaKind: "task",
                        agendaSource: null,
                        status: "open",
                        dueDate: null,
                        createdBy: actorUserId,
                        createdAt,
                        updatedAt: null,
                      },
                    ];
                  }
                  obligationReadCount += 1;
                  if (obligationReadCount === 1) {
                    return [];
                  }
                  return [
                    {
                      entityId,
                      workspaceId,
                      ownerUserId: null,
                      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
                      acknowledgedAt: null,
                      acknowledgedByUserId: null,
                      type: "task",
                      workingTargetDate: null,
                      hardDeadlineDate: null,
                      sourceType: "manual",
                      sourceEntityId: null,
                      sourceDescription: null,
                    },
                  ];
                },
              }),
            }),
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ entityId }] }),
        }),
      }),
      insert: (table: unknown) => ({
        values: () => {
          if (table === workObligations) {
            insertedLegacyObligation = true;
          }
          return { onConflictDoNothing: async () => {} };
        },
      }),
    });
    const request = new Request("https://api.example.test/work-obligations");
    const recordAuditEvent = createAuditRecorder({
      organizationId: toSafeId<"organization">(
        "0198fa3d-fc8d-7000-8000-000000000014",
      ),
      workspaceId,
      userId: actorUserId,
      request,
      server: null,
    });

    const result = await updateWorkObligation.handler(
      asTestRaw<UpdateContext>({
        body: { workingTargetDate: "2026-08-21" },
        createAuditRecorder: () => recordAuditEvent,
        memberRole: { role: "owner" },
        orgAIConfig: null,
        params: { workspaceId, entityId },
        recordAuditEvent,
        request,
        safeDb,
        scopedDb,
        session: {
          activeOrganizationId: toSafeId<"organization">(
            "0198fa3d-fc8d-7000-8000-000000000014",
          ),
        },
        user: { id: actorUserId },
        workspaceId,
      }),
    );

    expect(result).toEqual({ success: true });
    expect(insertedLegacyObligation).toBe(true);
    expect(obligationReadCount).toBe(2);
  });

  test("refuses a non-management member reassigning already-owned work to themselves", async () => {
    const workspaceId = toSafeId<"workspace">(
      "0198fa3d-fc8d-7000-8000-000000000021",
    );
    const entityId = toSafeId<"entity">("0198fa3d-fc8d-7000-8000-000000000022");
    const actorUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000023",
    );
    const previousOwnerUserId = toSafeId<"user">(
      "0198fa3d-fc8d-7000-8000-000000000024",
    );

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => ({
              for: async () => {
                if (table === workspaceMembers) {
                  return [{ userId: actorUserId }];
                }
                return [
                  {
                    entityId,
                    workspaceId,
                    ownerUserId: previousOwnerUserId,
                    status: WORK_OBLIGATION_STATUS.ACTIVE,
                    acknowledgedAt: new Date(),
                    acknowledgedByUserId: previousOwnerUserId,
                    type: "task",
                    workingTargetDate: null,
                    hardDeadlineDate: null,
                    sourceType: "manual",
                    sourceEntityId: null,
                    sourceDescription: null,
                  },
                ];
              },
            }),
          }),
        }),
      }),
    });
    const request = new Request("https://api.example.test/work-obligations");
    const recordAuditEvent = createAuditRecorder({
      organizationId: toSafeId<"organization">(
        "0198fa3d-fc8d-7000-8000-000000000025",
      ),
      workspaceId,
      userId: actorUserId,
      request,
      server: null,
    });

    const result = await updateWorkObligation.handler(
      asTestRaw<UpdateContext>({
        body: { ownerUserId: actorUserId, reason: "Taking this over" },
        createAuditRecorder: () => recordAuditEvent,
        memberRole: { role: "member" },
        orgAIConfig: null,
        params: { workspaceId, entityId },
        recordAuditEvent,
        request,
        safeDb,
        scopedDb,
        session: {
          activeOrganizationId: toSafeId<"organization">(
            "0198fa3d-fc8d-7000-8000-000000000025",
          ),
        },
        user: { id: actorUserId },
        workspaceId,
      }),
    );

    expect(result).toMatchObject({
      code: 403,
      response: {
        message:
          "Only an admin or owner can reassign work already owned by someone else",
      },
    });
  });
});
