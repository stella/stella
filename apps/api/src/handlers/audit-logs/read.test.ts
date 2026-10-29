import { Result } from "better-result";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { queryAuditLogPage } from "./query";

afterEach(() => {
  mock.restore();
});

describe("queryAuditLogPage", () => {
  test("resolves distinct accessible matters once and hides deleted or denied names", async () => {
    const auditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const secondAuditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const deletedAuditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const deniedAuditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const unknownAuditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const unknownAuditLogWithChangesId = toSafeId<"auditLog">(
      Bun.randomUUIDv7(),
    );
    const userId = toSafeId<"user">("user_test");
    const createdAt = new Date("2026-07-16T12:00:00.000Z");
    const events: Parameters<AuditRecorder>[1][] = [];
    let selectCount = 0;
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);

    const { safeDb } = createScopedDbMock({
      select: () => {
        selectCount += 1;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [
                    {
                      id: auditLogId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "update",
                      resourceType: "workspace",
                      resourceId: "workspace_test",
                      changes: null,
                      changesStatus: "visible",
                    },
                    {
                      id: deletedAuditLogId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "delete",
                      resourceType: "workspace",
                      resourceId: "workspace_deleted",
                      changes: null,
                      changesStatus: "visible",
                    },
                    {
                      id: deniedAuditLogId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "update",
                      resourceType: "workspace",
                      resourceId: "workspace_denied",
                      changes: null,
                      changesStatus: "visible",
                    },
                    {
                      id: unknownAuditLogId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "update",
                      resourceType: "retired_record_kind",
                      resourceId: "retired_record_test",
                      changes: null,
                      changesStatus: "visible",
                    },
                    {
                      id: secondAuditLogId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "update",
                      resourceType: "workspace",
                      resourceId: "workspace_second",
                      changes: { status: { old: "active", new: "archived" } },
                      changesStatus: "visible",
                    },
                    {
                      id: unknownAuditLogWithChangesId,
                      createdAt,
                      createdAtCursor: createdAt.toISOString(),
                      userId,
                      action: "update",
                      resourceType: "retired_record_kind",
                      resourceId: "retired_record_with_changes_test",
                      changes: { title: { old: "Old", new: "New" } },
                    },
                  ],
                }),
              }),
            }),
          };
        }

        if (selectCount === 2) {
          return {
            from: () => ({
              innerJoin: () => ({
                where: async () => [
                  { id: userId, name: "Test User", email: "test@example.com" },
                ],
              }),
            }),
          };
        }

        return {
          from: () => ({
            where: async () => [
              { id: "workspace_test", name: "Northwind acquisition" },
              { id: "workspace_second", name: "Contoso dispute" },
            ],
          }),
        };
      },
    });

    const result = await Result.gen(() =>
      queryAuditLogPage({
        safeDb,
        organizationId: toSafeId<"organization">("organization_test"),
        userId,
        featureAccessSnapshot: undefined,
        recordAuditEvent: async (_tx, event) => {
          events.push(event);
        },
        query: { limit: 20 },
      }),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(Result.isOk(result)).toBe(true);
    expect(result.value.items).toEqual([
      {
        id: auditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "workspace",
        resourceId: "workspace_test",
        resource: {
          kind: "workspace",
          id: "workspace_test",
          name: "Northwind acquisition",
          available: true,
        },
        changes: null,
        changesStatus: "visible",
      },
      {
        id: deletedAuditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "delete",
        resourceType: "workspace",
        resourceId: "workspace_deleted",
        resource: {
          kind: "workspace",
          id: "workspace_deleted",
          name: null,
          available: false,
        },
        changes: null,
        changesStatus: "visible",
      },
      {
        id: deniedAuditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "workspace",
        resourceId: "workspace_denied",
        resource: {
          kind: "workspace",
          id: "workspace_denied",
          name: null,
          available: false,
        },
        changes: null,
        changesStatus: "visible",
      },
      {
        id: unknownAuditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "retired_record_kind",
        resourceId: "retired_record_test",
        resource: {
          kind: "unknown",
          rawKind: "retired_record_kind",
          id: "retired_record_test",
          name: null,
          available: false,
        },
        changes: null,
        changesStatus: "visible",
      },
      {
        id: secondAuditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "workspace",
        resourceId: "workspace_second",
        resource: {
          kind: "workspace",
          id: "workspace_second",
          name: "Contoso dispute",
          available: true,
        },
        changes: { status: { old: "active", new: "archived" } },
        changesStatus: "visible",
      },
      {
        id: unknownAuditLogWithChangesId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "retired_record_kind",
        resourceId: "retired_record_with_changes_test",
        resource: {
          kind: "unknown",
          rawKind: "retired_record_kind",
          id: "retired_record_with_changes_test",
          name: null,
          available: false,
        },
        changes: null,
        changesStatus: "unrecognized_resource",
      },
    ]);
    expect(selectCount).toBe(3);
    expect(warning).toHaveBeenCalledWith(
      "audit_log.stored_resource_kind_unknown",
      { kind: "retired_record_kind", count: 2 },
    );
    expect(events).toEqual([
      {
        action: "access",
        resourceType: "audit_log",
        resourceId: "organization-logs",
      },
    ]);
  });

  test("does not record access when the page query fails", async () => {
    let auditCallCount = 0;
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                throw new Error("query failed");
              },
            }),
          }),
        }),
      }),
    });

    const result = await Result.gen(() =>
      queryAuditLogPage({
        safeDb,
        organizationId: toSafeId<"organization">("organization_test"),
        userId: null,
        featureAccessSnapshot: undefined,
        recordAuditEvent: async () => {
          auditCallCount += 1;
        },
        query: {},
      }),
    );

    expect(Result.isError(result)).toBe(true);
    expect(auditCallCount).toBe(0);
  });
});
