import { beforeEach, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

const executeMock = mock(
  async (_query: SQL): Promise<Record<string, unknown>[]> => [],
);

void mock.module("@/api/db/root", () => ({
  rootDb: { execute: executeMock },
}));

const { repairSearchSemanticTimestamps } =
  await import("@/api/lib/scheduler/tasks/search-semantic-timestamps");

beforeEach(() => {
  executeMock.mockClear();
});

test("repairs one bounded batch and checkpoints after the update", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock.mockResolvedValueOnce([{ entityId }]).mockResolvedValueOnce([]);

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    repaired: 1,
  });
  expect(executeMock).toHaveBeenCalledTimes(2);

  const dialect = new PgDialect();
  const repairQuery = dialect.sqlToQuery(
    executeMock.mock.calls.at(0)?.at(0) ?? sql``,
  );
  const checkpointQuery = dialect.sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );

  expect(repairQuery.sql).toContain("LIMIT");
  expect(repairQuery.sql).toContain(
    "sd.updated_at IS DISTINCT FROM COALESCE(e.updated_at, e.created_at)",
  );
  expect(repairQuery.params).toContain(500);
  expect(checkpointQuery.sql).toContain(
    "SET payload = jsonb_build_object('cursor'",
  );
  expect(checkpointQuery.params).toContain(entityId);
});

test("disables the versioned repair job after reaching a fixed point", async () => {
  executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: { cursor: "11111111-1111-4111-8111-111111111111" },
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({ status: "complete" });
  expect(executeMock).toHaveBeenCalledTimes(2);

  const disableQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(disableQuery.sql).toContain("SET enabled = false");
});

test("does not touch durable state after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: controller.signal,
  });

  expect(outcome).toEqual({ status: "aborted" });
  expect(executeMock).not.toHaveBeenCalled();
});
