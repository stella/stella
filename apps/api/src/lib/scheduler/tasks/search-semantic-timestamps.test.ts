import { beforeEach, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

const executeMock = mock(
  async (_query: SQL): Promise<Record<string, unknown>[]> => [],
);
const upsertSearchDocumentMock = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: { execute: executeMock },
}));

void mock.module("@/api/lib/search/index-entity", () => ({
  upsertSearchDocument: upsertSearchDocumentMock,
}));

const { repairSearchSemanticTimestamps } =
  await import("@/api/lib/scheduler/tasks/search-semantic-timestamps");

beforeEach(() => {
  executeMock.mockClear();
  upsertSearchDocumentMock.mockClear();
});

test("repairs one bounded batch and checkpoints after the update", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        repairedEntityId: entityId,
        searchDocumentMissing: false,
      },
    ])
    .mockResolvedValueOnce([]);

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
  expect(repairQuery.sql.indexOf("LIMIT")).toBeLessThan(
    repairQuery.sql.indexOf("IS DISTINCT FROM"),
  );
  expect(repairQuery.sql).toContain(
    "sd.updated_at IS DISTINCT FROM page.semantic_updated_at",
  );
  expect(repairQuery.params).toContain(500);
  expect(checkpointQuery.sql).toContain("SET payload = jsonb_build_object(");
  expect(checkpointQuery.sql).toContain("'cursor'");
  expect(checkpointQuery.params).toContain(entityId);
});

test("checkpoints the last scanned row when a clean page needs no repair", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        repairedEntityId: null,
        searchDocumentMissing: false,
      },
    ])
    .mockResolvedValueOnce([]);

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: { pass: "verify" },
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    repaired: 0,
  });
  const checkpointQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(checkpointQuery.params).toContain(entityId);
  expect(checkpointQuery.params).toContain("verify");
});

test("rebuilds a missing projection before checkpointing its entity", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        repairedEntityId: null,
        searchDocumentMissing: true,
      },
    ])
    .mockResolvedValueOnce([]);

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
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(entityId);
});

test("requires a clean verification pass before disabling the job", async () => {
  executeMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  const restartOutcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: new AbortController().signal,
  });

  expect(restartOutcome).toEqual({ status: "restart" });
  const restartQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(restartQuery.sql).toContain("SET payload = jsonb_build_object('pass'");

  const completeOutcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: { pass: "verify" },
    signal: new AbortController().signal,
  });

  expect(completeOutcome).toEqual({ status: "complete" });
  expect(executeMock).toHaveBeenCalledTimes(4);
  const disableQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(3)?.at(0) ?? sql``,
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
