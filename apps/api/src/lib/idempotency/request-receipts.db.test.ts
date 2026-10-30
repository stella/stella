import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, TransactionRollbackError } from "drizzle-orm";
import * as v from "valibot";

import { moneySchema } from "@stll/api-contract/billing-money";

import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  contacts,
  requestIdempotencyReceipts as receipts,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import {
  createOrganizationScopedTestDb,
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { scheduledMeasurementDatabase } from "@/api/tests/query-perf/scheduled-run";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import {
  REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
  sweepExpiredRequestReceipts,
} from "./request-receipts";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(releaseRlsFixture);

test("state-specific retention drains bounded mixed expiry batches and leaves the replay window intact", async () => {
  const { testDb, ids } = fixture;
  const scopedDb = createScopedDb(testDb, [], ids.orgA, ids.userA1);
  const now = new Date("2026-01-10T12:00:00Z");
  const rows = ["completed", "pending"].flatMap((state) =>
    Array.from(
      { length: REQUEST_RECEIPT_RETENTION_BATCH_SIZE + 1 },
      (_, index) => ({
        id: createSafeId<"requestIdempotencyReceipt">(),
        organizationId: ids.orgA,
        userId: ids.userA1,
        idempotencyKey: `${state}-${index}`,
        route: "/retention-test",
        requestFingerprint: "a".repeat(64),
        ...(state === "completed"
          ? {
              state: "completed" as const,
              responseCode: 200,
              completedAt: new Date("2026-01-01T00:00:00Z"),
              claimedAt: new Date("2026-01-01T00:00:00Z"),
            }
          : {
              state: "pending" as const,
              claimedAt: new Date("2026-01-10T11:00:00Z"),
            }),
      }),
    ),
  );
  const live = [
    {
      id: createSafeId<"requestIdempotencyReceipt">(),
      idempotencyKey: "live-completed",
      state: "completed" as const,
      responseCode: 200,
      completedAt: now,
      claimedAt: new Date("2026-01-10T11:00:00Z"),
      organizationId: ids.orgA,
      userId: ids.userA1,
      route: "/retention-test",
      requestFingerprint: "a".repeat(64),
    },
    {
      id: createSafeId<"requestIdempotencyReceipt">(),
      idempotencyKey: "live-pending",
      state: "pending" as const,
      claimedAt: now,
      organizationId: ids.orgA,
      userId: ids.userA1,
      route: "/retention-test",
      requestFingerprint: "a".repeat(64),
    },
  ];
  await scopedDb(
    async (tx) => await tx.insert(receipts).values([...rows, ...live]),
  );
  const sweep = async () =>
    await sweepExpiredRequestReceipts({
      db: asTestRaw<SchedulerDb>(testDb),
      now,
      signal: new AbortController().signal,
      deadline: 100,
      elapsedMs: () => 0,
    });
  const captured = await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx) => {
        const deleted = await sweepExpiredRequestReceipts({
          db: asTestRaw<SchedulerDb>(
            scheduledMeasurementDatabase(asTestRaw<Transaction>(tx)),
          ),
          now,
          signal: new AbortController().signal,
          deadline: 100,
          elapsedMs: () => 0,
        });
        expect(deleted).toEqual({
          deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
          hasMore: true,
        });
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  expect(
    captured.isErr() && captured.error instanceof TransactionRollbackError,
  ).toBe(true);
  expect(await sweep()).toEqual({
    deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    hasMore: true,
  });
  expect(await sweep()).toEqual({
    deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    hasMore: true,
  });
  expect(await sweep()).toEqual({ deleted: 2, hasMore: false });
  expect(await sweep()).toEqual({ deleted: 0, hasMore: false });
  const retained = await scopedDb(
    async (tx) => await tx.select({ id: receipts.id }).from(receipts),
  );
  expect(retained.map(({ id }) => id).toSorted()).toEqual(
    live.map(({ id }) => id).toSorted(),
  );
});

test("HTTP monetary responses recheck current authority for fresh requests and stored receipts", async () => {
  const { testDb, ids } = fixture;
  const scopedDb = createOrganizationScopedTestDb(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  let billingAccess = true;
  let authorized = true;
  let redacted = false;
  let authorizations = 0;
  const createdIds: ReturnType<typeof createSafeId<"contact">>[] = [];
  const endpoint = createSafeRootHandler(
    {
      contract: "patch",
      permissions: { workspace: ["read"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "health_infra" },
      idempotency: { type: "replay" },
      moneyResponse: v.looseObject({ renamed: v.nullable(moneySchema) }),
    },
    async function* ({ safeDb }) {
      const id = createSafeId<"contact">();
      createdIds.push(id);
      yield* Result.await(
        safeDb(
          async (tx) =>
            await tx.insert(contacts).values({
              id,
              organizationId: ids.orgA,
              type: "person",
              displayName: "Response fixture",
            }),
        ),
      );
      return Result.ok(status(201, { renamed: redacted ? null : cents(123) }));
    },
    {
      authorize: async () => {
        authorizations += 1;
        return authorized
          ? Result.ok(undefined)
          : Result.err(
              new HandlerError({
                status: 403,
                message: "Current membership required",
              }),
            );
      },
    },
  );
  await using server = serveForTest(
    createHttpApp({
      middleware: [],
      routes: routes({
        "/response-fixture": {
          POST: {
            access: "public",
            config: {},
            run: async ({ ctx }) =>
              await endpoint.handler(
                asTestRaw(
                  createTestHandlerContext({
                    audit: NO_AUDIT,
                    scopedDb,
                    safeDb: safeDbFromScoped(scopedDb),
                    memberRole: sessionMemberRole("member", billingAccess),
                    session: { activeOrganizationId: ids.orgA },
                    user: { id: ids.userA1 },
                    request: ctx.request,
                    set: ctx.set,
                    route: "/response-fixture",
                    body: {},
                    params: {},
                    query: {},
                  }),
                ),
              ),
          },
        },
      }),
    }),
  );
  const invoke = async (key: string) =>
    await server.fetch("https://example.test/response-fixture", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
  const first = await invoke("money-allowed");
  expect(first.status).toBe(201);
  expect(await first.json()).toEqual({ renamed: 123 });
  expect(createdIds).toHaveLength(1);
  const replay = await invoke("money-allowed");
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual({ renamed: 123 });
  expect(authorizations).toBe(2);
  expect(createdIds).toHaveLength(1);

  billingAccess = false;
  const deniedReplay = await invoke("money-allowed");
  expect(deniedReplay.status).toBe(403);
  expect(await deniedReplay.json()).toMatchObject({ message: "Forbidden" });
  expect(authorizations).toBe(3);
  expect(createdIds).toHaveLength(1);
  const deniedFresh = await invoke("money-denied");
  expect(deniedFresh.status).toBe(403);
  expect(await deniedFresh.json()).toMatchObject({ message: "Forbidden" });
  expect(authorizations).toBe(4);
  expect(createdIds).toHaveLength(2);
  expect(
    await scopedDb(
      async (tx) =>
        await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(inArray(contacts.id, createdIds)),
    ),
  ).toEqual([{ id: createdIds.at(0) }]);
  expect(
    await scopedDb(
      async (tx) =>
        await tx
          .select({ key: receipts.idempotencyKey })
          .from(receipts)
          .where(
            inArray(receipts.idempotencyKey, ["money-allowed", "money-denied"]),
          ),
    ),
  ).toEqual([{ key: "money-allowed" }]);

  authorized = false;
  billingAccess = true;
  const deniedAuthorization = await invoke("money-allowed");
  expect(deniedAuthorization.status).toBe(403);
  expect(await deniedAuthorization.json()).toMatchObject({
    message: "Current membership required",
  });
  expect(authorizations).toBe(5);
  expect(createdIds).toHaveLength(2);
  authorized = true;
  const retained = await invoke("money-allowed");
  expect(retained.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await retained.json()).toEqual({ renamed: 123 });

  billingAccess = false;
  redacted = true;
  for (const attempt of ["fresh", "replay"]) {
    const answer = await invoke("money-redacted");
    expect(answer.status, attempt).toBe(201);
    expect(await answer.json()).toEqual({ renamed: null });
    expect(answer.headers.get("Idempotency-Replayed"), attempt).toBe(
      attempt === "replay" ? "true" : null,
    );
  }
  expect(createdIds).toHaveLength(3);
  expect(authorizations).toBe(8);
});
