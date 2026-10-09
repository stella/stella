import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import Elysia from "elysia";
import * as v from "valibot";

import {
  DESKTOP_TIME_ENTRY_BATCH_STATUSES,
  desktopTimeEntryBatchResponseSchema,
} from "@stll/api-contract/desktop-time-entries";

import { desktopTimeEntryBatches, timeEntries } from "@/api/db/schema";
import { env } from "@/api/env";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import { aggregateExecutionRows } from "@/api/lib/db/aggregate-lock-order.fixture";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createTestState } from "@/api/tests/helpers/test-state";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import {
  createDesktopTimeEntryBatchEndpoint,
  desktopBatchFingerprint,
} from "./batch";
import { createDesktopTimeEntryBatchStatusEndpoint } from "./batch-status";

const testState = createTestState({ file: import.meta.path, config: env });
const MATTER = "00000000-0000-4000-8000-00000000abcd";
const BODY = {
  idempotencyKey: "review",
  entries: [
    {
      matterId: MATTER,
      dateWorked: new Date().toISOString().slice(0, 10),
      timezoneId: "UTC",
      durationMinutes: 6,
      narrative: "Reviewed agreement",
      billable: false,
    },
  ],
};
const receiptSchema = v.object({
  requestFingerprint: v.nullable(v.string()),
  status: v.picklist(DESKTOP_TIME_ENTRY_BATCH_STATUSES),
  result: v.nullable(desktopTimeEntryBatchResponseSchema),
});
test("batch fingerprint follows reviewed field values rather than JSON key order", () => {
  const entry = BODY.entries.at(0);
  if (!entry) {
    panic("Missing fixture entry");
  }
  const {
    matterId,
    dateWorked,
    timezoneId,
    durationMinutes,
    narrative,
    billable,
  } = entry;
  expect(desktopBatchFingerprint(BODY)).toBe(
    desktopBatchFingerprint({
      entries: [
        {
          billable,
          narrative,
          durationMinutes,
          timezoneId,
          dateWorked,
          matterId,
        },
      ],
      idempotencyKey: "different-key",
    }),
  );
  expect(desktopBatchFingerprint(BODY)).not.toBe(
    desktopBatchFingerprint({
      ...BODY,
      entries: [{ ...entry, narrative: "Changed" }],
    }),
  );
});

const createBatchHarness = (existingEntries = 0) => {
  let receipt: v.InferOutput<typeof receiptSchema> | undefined;
  let missingMatter = false;
  const writes: unknown[] = [];
  const { scopedDb } = createScopedDbMock(
    {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
      query: {
        workspaces: {
          findMany: async () => (missingMatter ? [] : [{ id: MATTER }]),
          findFirst: async () => ({ leadUserId: null }),
        },
        organizationSettings: { findFirst: async () => DEFAULT_TIME_POLICY },
        rateTables: { findFirst: async () => undefined },
      },
      select: () => createSelectQueryMock(receipt ? [receipt] : []),
      $count: async () => existingEntries,
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (table === desktopTimeEntryBatches) {
            receipt = v.parse(receiptSchema, row);
          }
          if (table === timeEntries) {
            writes.push(row);
          }
          return {
            returning: async () => [
              { id: "00000000-0000-4000-8000-000000000002" },
            ],
          };
        },
      }),
    },
    {
      featureAccess: {
        identity: { email: "desktop@example.test", emailVerified: true },
        enrolments: [
          {
            featureId: "time-billing",
            organizationId: "org_test",
            userId: "user_test",
          },
        ],
      },
    },
  );
  const authorizeAccount = async () =>
    Result.ok({
      scopedDb,
      organizationId: toSafeId<"organization">("org_test"),
      userId: toSafeId<"user">("user_test"),
      keyId: "desktop-key",
      memberRole: sessionMemberRole("member"),
    });
  const endpoint = createDesktopTimeEntryBatchEndpoint(authorizeAccount);
  const statusEndpoint =
    createDesktopTimeEntryBatchStatusEndpoint(authorizeAccount);
  const app = new Elysia()
    .put("/batch", endpoint.handler, {
      body: endpoint.config.body,
      response: endpoint.config.response,
    })
    .put("/status", statusEndpoint.handler, {
      body: statusEndpoint.config.body,
      response: statusEndpoint.config.response,
    });
  const status = async () =>
    await app.handle(
      new Request("http://localhost/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: BODY.idempotencyKey }),
      }),
    );
  const send = async (body: typeof BODY) =>
    await app.handle(
      new Request("http://localhost/batch", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [
      {
        type: "member",
        organizationId: "org_test",
        email: "desktop@example.test",
      },
    ],
  });
  return {
    send,
    status,
    writes,
    revokeMatter: () => {
      missingMatter = true;
    },
  };
};

test("batch replay converges and a changed payload or revoked matter refuses without new writes", async () => {
  const { send, writes, revokeMatter } = createBatchHarness();
  const first = await send(BODY);
  expect(first.status).toBe(200);
  const result = await first.json();
  const replay = await send(BODY);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(writes).toHaveLength(1);
  const changed = await send({
    ...BODY,
    entries: BODY.entries.map((entry) => ({
      ...entry,
      narrative: "Changed",
    })),
  });
  expect(changed.status).toBe(409);
  revokeMatter();
  expect((await send(BODY)).status).toBe(404);
  expect(writes).toHaveLength(1);
});

test("batch rejects unknown fields before authorization under default normalization", async () => {
  const endpoint = createDesktopTimeEntryBatchEndpoint(async () =>
    panic("Invalid batch must fail validation before authorization"),
  );
  const app = new Elysia().put("/batch", endpoint.handler, {
    body: endpoint.config.body,
    response: endpoint.config.response,
  });
  for (const extra of [
    { appName: "private" },
    { rawSegments: [] },
    { summary: "private" },
    { taskCode: "private" },
  ]) {
    for (const body of [
      { ...BODY, ...extra },
      {
        ...BODY,
        entries: BODY.entries.map((entry) => ({ ...entry, ...extra })),
      },
    ]) {
      const response = await app.handle(
        new Request("http://localhost/batch", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
    }
  }
});

test("uppercase matter identifiers converge with lowercase database identities and fingerprints", async () => {
  const { send, writes } = createBatchHarness();
  const uppercase = {
    ...BODY,
    entries: BODY.entries.map((entry) => ({
      ...entry,
      matterId: entry.matterId.toUpperCase(),
    })),
  };
  expect(uppercase.entries.at(0)?.matterId).not.toBe(MATTER);
  expect(desktopBatchFingerprint(uppercase)).toBe(
    desktopBatchFingerprint(BODY),
  );
  const created = await send(uppercase);
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({
    entries: [{ id: "00000000-0000-4000-8000-000000000002", matterId: MATTER }],
  });
  expect((await send(BODY)).status).toBe(200);
  expect(writes).toHaveLength(1);
  expect(writes.at(0)).toMatchObject({ workspaceId: MATTER });
});

test("recovery cancels a noncommitted batch after rejection and fences delayed originals", async () => {
  const { send, status, writes } = createBatchHarness();
  // The first attempt was not delivered; a subsequent attempt is definitively rejected.
  expect(
    (
      await send({
        ...BODY,
        entries: BODY.entries.map((entry) => ({
          ...entry,
          durationMinutes: 0,
        })),
      })
    ).status,
  ).toBe(422);
  const recovered = await status();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ type: "cancelled" });
  expect(await (await status()).json()).toEqual({ type: "cancelled" });
  expect((await send(BODY)).status).toBe(409);
  expect(writes).toHaveLength(0);
});

test("recovery preserves a committed batch and returns its exact receipt without new writes", async () => {
  const { send, status, writes } = createBatchHarness();
  const created = await send(BODY);
  expect(created.status).toBe(200);
  const receipt = await created.json();
  const recovered = await status();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ type: "committed", ...receipt });
  expect((await send(BODY)).status).toBe(200);
  expect(writes).toHaveLength(1);
});

test("uppercase matter identifiers count towards the authorized matter capacity", async () => {
  const { send, writes } = createBatchHarness(LIMITS.timeEntriesPerWorkspace);
  const uppercase = {
    ...BODY,
    entries: BODY.entries.map((entry) => ({
      ...entry,
      matterId: entry.matterId.toUpperCase(),
    })),
  };
  expect((await send(uppercase)).status).toBe(400);
  expect(writes).toHaveLength(0);
});
