import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { queryAuditLogPage } from "./query";

describe("queryAuditLogPage", () => {
  test("records access only after the page query succeeds", async () => {
    const auditLogId = toSafeId<"auditLog">(Bun.randomUUIDv7());
    const userId = toSafeId<"user">("user_test");
    const createdAt = new Date("2026-07-16T12:00:00.000Z");
    const events: Parameters<AuditRecorder>[1][] = [];
    let selectCount = 0;

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
                    },
                  ],
                }),
              }),
            }),
          };
        }

        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => [
                { id: userId, name: "Test User", email: "test@example.com" },
              ],
            }),
          }),
        };
      },
    });

    const result = await Result.gen(() =>
      queryAuditLogPage({
        safeDb,
        organizationId: toSafeId<"organization">("organization_test"),
        recordAuditEvent: async (_tx, event) => {
          events.push(event);
        },
        query: { limit: 20 },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.items).toEqual([
      {
        id: auditLogId,
        createdAt,
        userId,
        actor: "Test User",
        action: "update",
        resourceType: "workspace",
        resourceId: "workspace_test",
        changes: null,
      },
    ]);
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
