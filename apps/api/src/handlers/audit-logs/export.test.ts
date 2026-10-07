import { describe, expect, test } from "bun:test";

import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import exportAuditLogs from "./export";

type ExportAuditLogsContext = Parameters<typeof exportAuditLogs.handler>[0];

describe("exportAuditLogs", () => {
  test("exports the standard chat change projection", async () => {
    const userId = toSafeId<"user">("user_test");
    let selectCount = 0;
    let auditCallCount = 0;
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
                      createdAt: new Date("2026-07-16T12:00:00.000Z"),
                      userId,
                      action: AUDIT_ACTION.UPDATE,
                      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
                      resourceId: "thread_test",
                      changes: {
                        title: { old: "Earlier title", new: "Later title" },
                        chatModel: { old: "model_a", new: "model_b" },
                      },
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
    const context = asTestRaw<ExportAuditLogsContext>({
      memberRole: sessionMemberRole("owner"),
      query: {},
      recordAuditEvent: auditRecorderDouble(() => {
        auditCallCount += 1;
      }),
      request: new Request("https://example.test/v1/audit-logs/export"),
      route: "/v1/audit-logs/export",
      safeDb,
      session: {
        activeOrganizationId: toSafeId<"organization">("organization_test"),
      },
      set: { headers: {} },
      user: { id: userId },
    });

    const result = await exportAuditLogs.handler(context);

    expect(result).toBe(
      "Time,User Name,User Email,Action,Resource Type,Resource ID,Changes,Changes Status\n" +
        '2026-07-16T12:00:00.000Z,Test User,test@example.com,update,chat_thread,thread_test,"{""chatModel"":{""old"":""model_a"",""new"":""model_b""}}",visible',
    );
    expect(result).not.toContain("Earlier title");
    expect(result).not.toContain("Later title");
    expect(auditCallCount).toBe(1);
  });

  test("rejects an incomplete export without recording a download", async () => {
    let auditCallCount = 0;
    const rows = Array.from(
      { length: LIMITS.exportRowLimit + 1 },
      (_, index) => ({ userId: `user_${index}` }),
    );
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      }),
    });
    const context = asTestRaw<ExportAuditLogsContext>({
      memberRole: sessionMemberRole("owner"),
      query: {},
      recordAuditEvent: auditRecorderDouble(() => {
        auditCallCount += 1;
      }),
      request: new Request("https://example.test/v1/audit-logs/export"),
      route: "/v1/audit-logs/export",
      safeDb,
      session: {
        activeOrganizationId: toSafeId<"organization">("organization_test"),
      },
      set: { headers: {} },
      user: { id: toSafeId<"user">("user_test") },
    });

    const result = await exportAuditLogs.handler(context);

    expect(result).toEqual({
      code: 413,
      response: {
        message: `The export exceeds ${LIMITS.exportRowLimit} rows. Narrow the filters and try again.`,
      },
    });
    expect(auditCallCount).toBe(0);
  });
});
