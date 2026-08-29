import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { rootDb } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const executeMock = mock(
  async (_query: SQL): Promise<Record<string, unknown>[]> => [],
);
const upsertSearchDocumentMock = mock(async () => undefined);

const { repairSearchSemanticTimestamps } =
  await import("@/api/lib/scheduler/tasks/search-semantic-timestamps");

const runRepair = async (
  options: Parameters<typeof repairSearchSemanticTimestamps>[0],
) =>
  await repairSearchSemanticTimestamps({
    ...options,
    db: asTestRaw<Pick<typeof rootDb, "execute">>({ execute: executeMock }),
    indexEntity: upsertSearchDocumentMock,
  });

let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  executeMock.mockClear();
  upsertSearchDocumentMock.mockClear();
});

afterEach(() => {
  analytics.restore();
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

  const outcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    failed: 0,
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

  const outcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:05:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 0,
      dirty: false,
      passStartedAt: "2026-07-29T00:00:00.000Z",
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    failed: 0,
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

  const outcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:05:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 1,
      dirty: false,
      passStartedAt: "2026-07-29T00:00:00.000Z",
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: entityId,
    failed: 0,
    repaired: 1,
  });
  const dirtyCheckpoint = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(dirtyCheckpoint.sql).toContain("'dirty', true");
  expect(dirtyCheckpoint.sql).toContain("'pass', $2::text");
  expect(dirtyCheckpoint.sql).toContain("'passStartedAt', $3::text");
  expect(dirtyCheckpoint.sql).toContain("'quietSince', $4::text");
  expect(dirtyCheckpoint.params).toContain("2026-07-29T00:05:00.000Z");
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(entityId);
});

test("requires two full clean passes started after the quiet window", async () => {
  executeMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  const restartOutcome = await runRepair({
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

  const earlyPassOutcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:20:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 0,
      dirty: false,
      passStartedAt: "2026-07-29T00:05:00.000Z",
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });
  expect(earlyPassOutcome).toEqual({ status: "restart" });
  const earlyPassCheckpoint = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(3)?.at(0) ?? sql``,
  );
  expect(earlyPassCheckpoint.params).toContain(0);
  expect(earlyPassCheckpoint.params).toContain("2026-07-29T00:20:00.000Z");

  const firstCleanOutcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:21:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 0,
      dirty: false,
      passStartedAt: "2026-07-29T00:20:00.000Z",
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });
  expect(firstCleanOutcome).toEqual({ status: "restart" });
  const firstCleanCheckpoint = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(5)?.at(0) ?? sql``,
  );
  expect(firstCleanCheckpoint.params).toContain(1);

  const completeOutcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    now: new Date("2026-07-29T00:22:00.000Z"),
    payload: {
      pass: "verify",
      cleanPasses: 1,
      dirty: false,
      passStartedAt: "2026-07-29T00:21:00.000Z",
      quietSince: "2026-07-29T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  });
  expect(completeOutcome).toEqual({ status: "complete" });
  expect(executeMock).toHaveBeenCalledTimes(8);
  const disableQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(7)?.at(0) ?? sql``,
  );
  expect(disableQuery.sql).toContain("SET enabled = false");
});

test("checkpoints past an unreadable entity and repairs the rest of the page", async () => {
  const unreadableEntityId = toSafeId<"entity">(
    "11111111-1111-4111-8111-111111111111",
  );
  const readableEntityId = toSafeId<"entity">(
    "22222222-2222-4222-8222-222222222222",
  );
  executeMock
    .mockResolvedValueOnce([
      { entityId: unreadableEntityId, needsReindex: true },
      { entityId: readableEntityId, needsReindex: true },
    ])
    .mockResolvedValueOnce([]);
  upsertSearchDocumentMock.mockRejectedValueOnce(
    new Error("content cannot decrypt"),
  );

  const outcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: new AbortController().signal,
  });

  expect(outcome).toEqual({
    status: "progress",
    cursor: readableEntityId,
    failed: 1,
    repaired: 1,
  });
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(unreadableEntityId);
  expect(upsertSearchDocumentMock).toHaveBeenCalledWith(readableEntityId);
  expect(analytics.exceptions().map((event) => event.properties)).toMatchObject(
    [
      {
        "error.class": "Error",
        entityId: unreadableEntityId,
        schedulerTask: "search.repairSemanticTimestamps",
      },
    ],
  );
  const checkpointQuery = new PgDialect().sqlToQuery(
    executeMock.mock.calls.at(1)?.at(0) ?? sql``,
  );
  expect(checkpointQuery.params).toContain(readableEntityId);
});

test("does not touch durable state after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  const outcome = await runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: controller.signal,
  });

  expect(outcome).toEqual({ status: "aborted" });
  expect(executeMock).not.toHaveBeenCalled();
});

test("does not checkpoint after cancellation during a bounded reindex", async () => {
  const entityIds = [
    toSafeId<"entity">("11111111-1111-4111-8111-111111111111"),
    toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
    toSafeId<"entity">("33333333-3333-4333-8333-333333333333"),
    toSafeId<"entity">("44444444-4444-4444-8444-444444444444"),
    toSafeId<"entity">("55555555-5555-4555-8555-555555555555"),
  ];
  const controller = new AbortController();
  let reindexStarts = 0;
  let resolveInitialBatchStarted: () => void = () => undefined;
  let resolveUpsert: () => void = () => undefined;
  const initialBatchStarted = new Promise<void>((resolve) => {
    resolveInitialBatchStarted = resolve;
  });
  const pendingUpsert = new Promise<void>((resolve) => {
    resolveUpsert = resolve;
  });
  executeMock.mockResolvedValueOnce(
    entityIds.map((entityId) => ({ entityId, needsReindex: true })),
  );
  upsertSearchDocumentMock.mockImplementation(async () => {
    reindexStarts += 1;
    if (reindexStarts === 4) {
      resolveInitialBatchStarted();
    }
    await pendingUpsert;
  });

  const outcomePromise = runRepair({
    jobId: "search.repairSemanticTimestamps.v1",
    leaseToken: "runner#lease-1",
    payload: null,
    signal: controller.signal,
  });
  await initialBatchStarted;
  controller.abort();
  resolveUpsert();

  const outcome = await outcomePromise;
  expect(outcome).toEqual({ status: "aborted" });
  expect(upsertSearchDocumentMock).toHaveBeenCalledTimes(4);
  expect(executeMock).toHaveBeenCalledTimes(1);
});
