import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createTestClock } from "@stll/test-kit";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { markRlsDatabase, TRANSACTION_DEADLINE } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { createMcpOperationDatabases } from "@/api/mcp/context";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const dialect = new PgDialect();

describe("MCP operation databases", () => {
  test("keep a token's workspace attenuation under the request deadline", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const clock = createTestClock();
      const { timeoutMs } = TRANSACTION_DEADLINE.request;
      const params: unknown[] = [];
      const tx = {
        execute: async (query: SQLWrapper | string) => {
          if (typeof query !== "string") {
            params.push(...dialect.sqlToQuery(query.getSQL()).params);
          }
          return await Promise.resolve([]);
        },
      };
      const database = markRlsDatabase({
        transaction: async <TResult>(
          fn: (open: typeof tx) => Promise<TResult>,
        ) => await fn(tx),
      });
      const workspaceId = createSafeId<"workspace">();
      const { safeDb, scopedDb } = createMcpOperationDatabases(
        asTestRaw<RlsDatabase<Transaction>>(database),
        {
          deadline: { ...TRANSACTION_DEADLINE.request, clock },
          organizationId: mintAuthProviderId<"organization">(),
          serverValidatedWorkspaceIds: [],
          tokenWorkspaceIds: [workspaceId],
          userId: mintAuthProviderId<"user">(),
        },
      );
      const overrun = async () => {
        await clock.advance(timeoutMs + 1);
      };

      await scopedDb(overrun);
      expect(Result.isOk(await safeDb(overrun))).toBe(true);

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map(([event]) => event)).toEqual([
        "database.transaction_over_deadline",
        "database.transaction_over_deadline",
      ]);
      expect(params).toContain(WORKSPACE_ACCESS_MODE.explicit);
      expect(params).toContain(`{${workspaceId}}`);
      expect(params).not.toContain(WORKSPACE_ACCESS_MODE.membership);
    } finally {
      warn.mockRestore();
    }
  });
});
