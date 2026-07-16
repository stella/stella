import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import exportAuditLogs from "./export";

type ExportAuditLogsContext = Parameters<typeof exportAuditLogs.handler>[0];

describe("exportAuditLogs", () => {
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
      memberRole: { role: "owner" },
      query: {},
      recordAuditEvent: async () => {
        auditCallCount += 1;
      },
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
