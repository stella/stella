import { beforeEach, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const executeMock = mock(
  async (_query: SQL): Promise<Record<string, unknown>[]> => [],
);
const transactionMock = mock();
const reconcileStaleBufferIntentsMock = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: { execute: executeMock, transaction: transactionMock },
}));
void mock.module("@/api/lib/buffer-intent-reconciliation", () => ({
  BUFFER_INTENT_STALE_MS: 60_000,
  reconcileStaleBufferIntents: reconcileStaleBufferIntentsMock,
}));

const { reconcileBufferIntents } =
  await import("@/api/lib/scheduler/tasks/buffer-intent-reconciliation");

beforeEach(() => {
  executeMock.mockReset();
  transactionMock.mockReset();
  reconcileStaleBufferIntentsMock.mockReset();
  reconcileStaleBufferIntentsMock.mockResolvedValue(undefined);
});

test("independently schedules bounded recovery for both buffer intent kinds", async () => {
  const organizationId = toSafeId<"organization">(
    "11111111-1111-4111-8111-111111111111",
  );
  const workspaceId = toSafeId<"workspace">(
    "22222222-2222-4222-8222-222222222222",
  );
  executeMock.mockResolvedValue([
    { organizationId, workspaceId, purpose: "entity_create" },
    { organizationId, workspaceId, purpose: "entity_version" },
  ]);
  const info = mock();

  await reconcileBufferIntents(
    asTestRaw<SchedulerTaskContext>({
      logger: { info },
      signal: new AbortController().signal,
    }),
  );

  expect(reconcileStaleBufferIntentsMock).toHaveBeenNthCalledWith(1, {
    safeDb: expect.any(Function),
    organizationId,
    workspaceId,
    purpose: "entity_create",
  });
  expect(reconcileStaleBufferIntentsMock).toHaveBeenNthCalledWith(2, {
    safeDb: expect.any(Function),
    organizationId,
    workspaceId,
    purpose: "entity_version",
  });
  expect(info).toHaveBeenCalledWith("scheduler.buffer_intents_reconciled", {
    "bufferIntents.scopes": 2,
  });

  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(executeMock.mock.calls[0]?.[0] ?? sql``);
  expect(query.sql).toContain("purpose IN ('entity_create', 'entity_version')");
  expect(query.sql).toContain("purpose_data->>'reservedFileId' IS NOT NULL");
  expect(query.sql).toContain("status = 'scanning'");
  expect(query.sql).toContain("claimed_at < NOW()");
  expect(query.sql).toContain("LIMIT");
  expect(query.params).toEqual([60, 50]);
});
