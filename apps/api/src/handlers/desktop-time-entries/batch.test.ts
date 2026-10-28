import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  DESKTOP_TIME_ENTRY_BATCH_STATUSES,
  type DesktopTimeEntryBatch,
  desktopTimeEntryBatchResponseSchema,
} from "@stll/api-contract/desktop-time-entries";
import { sha256Hex } from "@stll/sha256/bun";

import {
  auditLogs,
  desktopTimeEntryBatches,
  timeEntries,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteTable } from "@/api/http/route";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { LIMITS } from "@/api/lib/limits";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { aggregateExecutionRows } from "@/api/tests/fixtures/aggregate-lock-order";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest } from "@/api/tests/helpers/test-server";
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
const CLIENT = "00000000-0000-4000-8000-00000000c11e";
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
const serve = (table: RouteTable) =>
  serveForTest(
    createHttpApp({ routes: routes(table), middleware: [errorBoundary] }),
  );

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

test("an entry without a classification keeps the fingerprint it had before the field", () => {
  const entry = BODY.entries.at(0) ?? panic("Missing fixture entry");
  expect(desktopBatchFingerprint(BODY)).toBe(
    sha256Hex(
      JSON.stringify([
        {
          matterId: entry.matterId,
          dateWorked: entry.dateWorked,
          timezoneId: entry.timezoneId,
          durationMinutes: entry.durationMinutes,
          narrative: entry.narrative,
          billable: entry.billable,
        },
      ]),
    ),
  );
  const classified = (taskCode: string) => ({
    ...BODY,
    entries: [
      {
        ...entry,
        classification: {
          type: "ledes" as const,
          activityCode: "A103",
          taskCode,
        },
      },
    ],
  });
  expect(desktopBatchFingerprint(classified("L120"))).not.toBe(
    desktopBatchFingerprint(BODY),
  );
  expect(desktopBatchFingerprint(classified("L120"))).not.toBe(
    desktopBatchFingerprint(classified("L110")),
  );
});

const createBatchHarness = (existingEntries = 0) => {
  let receipt: v.InferOutput<typeof receiptSchema> | undefined;
  let missingMatter = false;
  // The matter's client billing format; null is a matter without a client.
  let clientFormat: "ledes" | "categories" | null = null;
  let rateReads = 0;
  const writes: unknown[] = [];
  // Every insert in arrival order, so a test can place audit rows relative
  // to the entry and receipt writes of the same transaction.
  const inserts: string[] = [];
  const { scopedDb } = createScopedDbMock(
    {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
      query: {
        workspaces: {
          findMany: async () =>
            missingMatter
              ? []
              : [
                  {
                    id: MATTER,
                    clientId: clientFormat === null ? null : CLIENT,
                  },
                ],
          findFirst: async () => ({ leadUserId: null }),
        },
        organizationSettings: { findFirst: async () => DEFAULT_TIME_POLICY },
        rateTables: {
          findMany: async () => {
            rateReads += 1;
            return [];
          },
        },
      },
      select: (selection: Record<string, unknown>) =>
        "format" in selection
          ? createSelectQueryMock(
              clientFormat === null
                ? []
                : [{ id: CLIENT, format: clientFormat }],
            )
          : createSelectQueryMock(receipt ? [receipt] : []),
      $count: async () => existingEntries,
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (table === auditLogs) {
            inserts.push(
              ...(Array.isArray(row) ? row : [row]).map(() => "audit"),
            );
          }
          if (table === timeEntries) {
            inserts.push("entry");
          }
          if (table === desktopTimeEntryBatches) {
            inserts.push("receipt");
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
            organizationId: toSafeId<"organization">("org_test"),
            userId: "user_test",
          },
        ],
      },
    },
  );
  const deviceSigner = createDesktopDeviceSigner();
  const authorizeAccount = async (request: Request) => {
    const device = await deviceSigner;
    return Result.ok({
      featureAccessSnapshot: buildFeatureAccessSnapshot({
        organizationId: toSafeId<"organization">("org_test"),
        userId: "user_test",
        identity: { email: "desktop@example.test", emailVerified: true },
        enrolments: [
          {
            featureId: "time-billing",
            organizationId: "org_test",
            userId: "user_test",
          },
        ],
      }),
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "fixture-credential",
        }),
        deviceJkt: device.deviceJkt,
        keyId: "desktop-key",
        credential: "fixture-credential",
      }),
      scopedDb,
      organizationId: toSafeId<"organization">("org_test"),
      userId: toSafeId<"user">("user_test"),
      keyId: "desktop-key",
      memberRole: sessionMemberRole("member"),
    });
  };
  const endpoint = createDesktopTimeEntryBatchEndpoint(authorizeAccount);
  const statusEndpoint =
    createDesktopTimeEntryBatchStatusEndpoint(authorizeAccount);
  const server = serve({
    "/batch": { PUT: endpoint },
    "/status": { PUT: statusEndpoint },
  });
  const status = async () =>
    await server.fetch(
      new Request("http://localhost/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: BODY.idempotencyKey }),
      }),
    );
  const send = async (body: DesktopTimeEntryBatch) =>
    await server.fetch(
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
        organizationId: toSafeId<"organization">("org_test"),
        email: "desktop@example.test",
      },
    ],
  });
  return {
    send,
    status,
    writes,
    inserts,
    rateReads: () => rateReads,
    revokeMatter: () => {
      missingMatter = true;
    },
    billClientIn: (format: "ledes" | "categories" | null) => {
      clientFormat = format;
    },
    [Symbol.asyncDispose]: server.stop,
  };
};

test("batch replay converges and a changed payload or revoked matter refuses without new writes", async () => {
  await using harness = createBatchHarness();
  const { send, writes, revokeMatter } = harness;
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

test("batch rejects unknown fields before authorization", async () => {
  const endpoint = createDesktopTimeEntryBatchEndpoint(async () =>
    panic("Invalid batch must fail validation before authorization"),
  );
  await using server = serve({ "/batch": { PUT: endpoint } });
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
      const response = await server.fetch(
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

test.each(["2026-02-30", "1900-02-29", "2026-04-31", "0000-01-01"])(
  "batch rejects invalid calendar date %s before authorization",
  async (dateWorked) => {
    let authorizationCalls = 0;
    const endpoint = createDesktopTimeEntryBatchEndpoint(async () => {
      authorizationCalls += 1;
      return panic("Invalid calendar date must not reach authorization");
    });
    await using server = serve({ "/batch": { PUT: endpoint } });
    const response = await server.fetch(
      new Request("http://localhost/batch", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...BODY,
          entries: BODY.entries.map((entry) => ({ ...entry, dateWorked })),
        }),
      }),
    );
    expect(response.status).toBe(422);
    expect(authorizationCalls).toBe(0);
  },
);

test("uppercase matter identifiers converge with lowercase database identities and fingerprints", async () => {
  await using harness = createBatchHarness();
  const { send, writes } = harness;
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
  await using harness = createBatchHarness();
  const { send, status, writes } = harness;
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

test("entry creation is audited in the batch transaction; a cancellation receipt writes no entry or audit row", async () => {
  await using committed = createBatchHarness();
  expect((await committed.send(BODY)).status).toBe(200);
  // The audit skip in batch status covers only the receipt: the committed
  // batch audits its entries before the receipt closes the transaction.
  expect(committed.inserts).toContain("audit");
  expect(committed.inserts.indexOf("entry")).toBeLessThan(
    committed.inserts.lastIndexOf("audit"),
  );
  expect(committed.inserts.at(-1)).toBe("receipt");

  await using cancelled = createBatchHarness();
  expect(await (await cancelled.status()).json()).toEqual({
    type: "cancelled",
  });
  expect(cancelled.inserts).toEqual(["receipt"]);
});

test("recovery preserves a committed batch and returns its exact receipt without new writes", async () => {
  await using harness = createBatchHarness();
  const { send, status, writes } = harness;
  const created = await send(BODY);
  expect(created.status).toBe(200);
  const receipt = v.parse(
    desktopTimeEntryBatchResponseSchema,
    await created.json(),
  );
  const recovered = await status();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ type: "committed", ...receipt });
  expect((await send(BODY)).status).toBe(200);
  expect(writes).toHaveLength(1);
});

test("uppercase matter identifiers count towards the authorized matter capacity", async () => {
  await using harness = createBatchHarness(LIMITS.timeEntriesPerWorkspace);
  const { send, writes } = harness;
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

test("a full unpriced batch resolves rates once and preserves nonbillable entries", async () => {
  await using harness = createBatchHarness();
  const { send, writes, rateReads } = harness;
  const entry = BODY.entries.at(0);
  if (!entry) {
    panic("Missing fixture entry");
  }
  const response = await send({
    ...BODY,
    entries: Array.from(
      { length: DESKTOP_ACTIVITY_REVIEW_LIMIT },
      (_, index) => ({
        ...entry,
        narrative: `Reviewed agreement ${index}`,
      }),
    ),
  });
  expect(response.status).toBe(200);
  expect(writes).toHaveLength(DESKTOP_ACTIVITY_REVIEW_LIMIT);
  expect(rateReads()).toBe(1);
});

test("missing bulk rates reject billable entries without individual rate reads or writes", async () => {
  await using harness = createBatchHarness();
  const { send, writes, rateReads } = harness;
  const response = await send({
    ...BODY,
    entries: BODY.entries.map((entry) => ({ ...entry, billable: true })),
  });
  expect(response.status).toBe(400);
  expect(writes).toHaveLength(0);
  expect(rateReads()).toBe(1);
});

test("LEDES classification persists as codes; matter entries refuse the internal group", async () => {
  const { send, writes, billClientIn } = createBatchHarness();
  billClientIn("ledes");
  const entry = BODY.entries.at(0) ?? panic("Missing fixture entry");
  const ledes = await send({
    idempotencyKey: "classified",
    entries: [
      {
        ...entry,
        classification: {
          type: "ledes",
          taskCode: "L120",
          activityCode: "A103",
        },
      },
    ],
  });
  expect(ledes.status).toBe(200);
  expect(writes.at(0)).toMatchObject({
    taskCode: "L120",
    activityCode: "A103",
  });
  const internal = await send({
    idempotencyKey: "internal",
    entries: [
      {
        ...entry,
        classification: { type: "activity_group", activityGroup: "internal" },
      },
    ],
  });
  expect(internal.status).toBe(400);
  expect(writes).toHaveLength(1);
});

test("LEDES codes are refused unless the matter's client bills in LEDES", async () => {
  await using harness = createBatchHarness();
  const { send, writes, billClientIn } = harness;
  const entry = BODY.entries.at(0) ?? panic("Missing fixture entry");
  const coded = (idempotencyKey: string) => ({
    idempotencyKey,
    entries: [
      {
        ...entry,
        classification: {
          type: "ledes" as const,
          taskCode: "L120",
          activityCode: "A103",
        },
      },
    ],
  });
  for (const format of [null, "categories"] as const) {
    billClientIn(format);
    expect((await send(coded(`coded-${format}`))).status).toBe(400);
  }
  billClientIn("ledes");
  const grouped = await send({
    idempotencyKey: "grouped-ledes",
    entries: [
      {
        ...entry,
        classification: { type: "activity_group", activityGroup: "client" },
      },
    ],
  });
  expect(grouped.status).toBe(400);
  expect(writes).toHaveLength(0);
  billClientIn("categories");
  const accepted = await send({
    idempotencyKey: "grouped-categories",
    entries: [
      {
        ...entry,
        classification: { type: "activity_group", activityGroup: "client" },
      },
    ],
  });
  expect(accepted.status).toBe(200);
  expect(writes).toHaveLength(1);
});
