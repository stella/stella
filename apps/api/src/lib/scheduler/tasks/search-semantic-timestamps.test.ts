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

test("rebuilds one bounded page and checkpoints after the projection", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        needsReindex: true,
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
  expect(repairQuery.sql).toContain("source_page.indexed_updated_at");
  expect(repairQuery.sql).not.toContain("UPDATE search_documents");
  expect(repairQuery.params).toContain(500);
  expect(checkpointQuery.sql).toContain("SET payload = jsonb_build_object(");
  expect(checkpointQuery.sql).toContain("'cursor'");
  expect(checkpointQuery.params).toContain(entityId);
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(entityId);
});

test("checkpoints the last scanned row when a clean page needs no repair", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        needsReindex: false,
      },
    ])
    .mockResolvedValueOnce([]);

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:05:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 0,
      dirty: false,
      quietSince: "2026-07-29T00:00:00.000Z",
    },
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

test("durably marks verification dirty before rebuilding a mismatch", async () => {
  const entityId = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
  executeMock
    .mockResolvedValueOnce([
      {
        entityId,
        needsReindex: true,
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  const outcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:05:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 1,
      dirty: false,
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    repaired: 1,
  });
  const dirtyCheckpoint = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(dirtyCheckpoint.sql).toContain("'dirty', true");
  expect(dirtyCheckpoint.params).toContain("2026-07-29T00:05:00.000Z");
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(entityId);
});

test("requires a quiet two-pass fixed point before disabling the job", async () => {
  executeMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  const restartOutcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:00:00.000Z"),
    payload: null,
    signal: new AbortController().signal,
  });

  expect(restartOutcome).toEqual({ status: "restart" });
  const restartQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(restartQuery.sql).toContain("SET payload = jsonb_build_object(");
  expect(restartQuery.sql).toContain("'pass'");

  const firstCleanOutcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:20:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 0,
      dirty: false,
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });
  expect(firstCleanOutcome).toEqual({ status: "restart" });
  const firstCleanCheckpoint = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(3)?.at(0) ?? sql``,
  );
  expect(firstCleanCheckpoint.params).toContain(1);

  const completeOutcome = await repairSearchSemanticTimestamps({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:21:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 1,
      dirty: false,
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });
  expect(completeOutcome).toEqual({ status: "complete" });
  expect(executeMock).toHaveBeenCalledTimes(6);
  const disableQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(5)?.at(0) ?? sql``,
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
